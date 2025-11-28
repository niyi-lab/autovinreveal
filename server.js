/********************************************************************
 * AutoVINReveal Server – Stripe + PayPal + Supabase + Caching + Admin
 ********************************************************************/

import dotenv from "dotenv";
dotenv.config({ path: "/etc/secrets/.env" }); // Production
dotenv.config(); // Local dev

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import Stripe from "stripe";
import { gunzipSync } from "zlib";
import crypto from "crypto";
import { createRequire } from "module";
import cookieParser from "cookie-parser";
import nodemailer from "nodemailer";

const require = createRequire(import.meta.url);
const paypalSdk = require("@paypal/checkout-server-sdk");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

/* ================================================================
   Config (env)
================================================================ */
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || SITE_URL;
const FORCE_WWW = process.env.FORCE_WWW === "1";

const APP_SECRET = process.env.APP_SECRET || "change_me_in_env_file";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const ADMIN_SESSION_TTL_SECONDS = Number(process.env.ADMIN_SESSION_TTL_SECONDS || 60 * 60 * 12);

/* ================================================================
   Security / redirects
================================================================ */
app.set("trust proxy", 1);
const WEBHOOK_PATHS = new Set(["/api/stripe-webhook", "/api/stripe-webhook/"]);

app.use((req, res, next) => {
  if (WEBHOOK_PATHS.has(req.path)) return next();

  // Force HTTPS in production
  if (process.env.NODE_ENV === "production") {
    const xfProto = req.get("x-forwarded-proto");
    if (!req.secure && xfProto !== "https") {
      return res.redirect(308, `https://${req.headers.host}${req.url}`);
    }
  }
  // Optional force www
  if (FORCE_WWW && req.headers.host && !req.headers.host.startsWith("www.")) {
    return res.redirect(308, `https://www.${req.headers.host}${req.url}`);
  }
  next();
});

// Light CSP
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "upgrade-insecure-requests");
  next();
});

/* ================================================================
   Health
================================================================ */
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

/* ================================================================
   Stripe
================================================================ */
const stripeLive = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const STRIPE_TEST_SECRET_KEY = process.env.STRIPE_TEST_SECRET_KEY || null;

const PRICE_SINGLE = process.env.STRIPE_PRICE_SINGLE;
const PRICE_10PACK = process.env.STRIPE_PRICE_10PACK;
const PRICE_SINGLE_TEST = process.env.STRIPE_PRICE_SINGLE_TEST || null;
const PRICE_10PACK_TEST = process.env.STRIPE_PRICE_10PACK_TEST || null;

const CREDITS_PER_SINGLE = Number(process.env.CREDITS_PER_SINGLE || "1");
const CREDITS_PER_10PACK = Number(process.env.CREDITS_PER_10PACK || "5");

function stripeForId(id) {
  const isTest = typeof id === "string" && id.startsWith("cs_test_");
  if (isTest) {
    if (!STRIPE_TEST_SECRET_KEY) throw new Error("Test session but STRIPE_TEST_SECRET_KEY not set.");
    return new Stripe(STRIPE_TEST_SECRET_KEY, { apiVersion: "2024-06-20" });
  }
  return stripeLive;
}

/* ================================================================
   Supabase
================================================================ */
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY;

const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const supabaseService = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const supabaseForToken = (token) =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

async function getUser(req) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return { token: null, user: null };
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error) return { token: null, user: null };
  return { token, user: data.user };
}

/* ================================================================
   Email (Nodemailer)
================================================================ */
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = process.env.SMTP_SECURE !== "0"; 
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || "AutoVINReveal <autovinreveal@gmail.com>";

let mailer = null;
if (SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  mailer.verify().then(() => console.log("✅ SMTP mailer ready")).catch(e => console.error("❌ SMTP failed:", e));
} else {
  console.warn("⚠️ SMTP not configured. Emails will fail.");
}

/* ================================================================
   CarSimulcast API
================================================================ */
const CS = "https://connect.carsimulcast.com";
const KEY = process.env.API_KEY;
const SECRET = process.env.API_SECRET;
const H = { "API-KEY": KEY, "API-SECRET": SECRET };

async function csGet(url) {
  try {
    const r = await axios.get(url, {
      headers: H,
      responseType: "text",
      timeout: 30000,
      validateStatus: () => true,
    });
    if (r.status >= 400) {
      const body = String(r.data || "");
      const hint = body.slice(0, 200).toLowerCase();
      throw new Error(`CS_${r.status}:${hint}`);
    }
    return r.data;
  } catch (err) {
    const msg = String(err?.message || "cs-error");
    throw new Error(`CS_ERROR:${msg}`);
  }
}

/* ================================================================
   Cache / Helpers
================================================================ */
const CACHE_DIR = path.join(__dirname, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const ck = (vin, type) => path.join(CACHE_DIR, `${vin}-${type}.b64`);
const readCache = (vin, type) => fs.existsSync(ck(vin, type)) ? fs.readFileSync(ck(vin, type), "utf8") : null;
const writeCache = (vin, type, data) => fs.writeFileSync(ck(vin, type), data, "utf8");

const CONSUMED_FILE = path.join(__dirname, ".consumed_sessions.json");
let CONSUMED = new Set();
try {
  if (fs.existsSync(CONSUMED_FILE)) CONSUMED = new Set(JSON.parse(fs.readFileSync(CONSUMED_FILE, "utf8")));
} catch {}
function saveConsumed() {
  try { fs.writeFileSync(CONSUMED_FILE, JSON.stringify([...CONSUMED], null, 2)); } catch {}
}

function decodeReportBase64(rawB64) {
  const buf = Buffer.from(rawB64, "base64");
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return { kind: "html", html: gunzipSync(buf).toString("utf8") }; } 
    catch { return { kind: "unknown", buffer: buf, error: "gunzip-failed" }; }
  }
  if (buf.slice(0, 5).toString() === "%PDF-") return { kind: "pdf", buffer: buf };
  const asText = buf.toString("utf8");
  if (/<!DOCTYPE html|<html[\s>]/i.test(asText.slice(0, 2048))) return { kind: "html", html: asText };
  return { kind: "unknown", buffer: buf };
}

async function fetchAndCacheReport(vin, type = "carfax") {
  const live = await csGet(`${CS}/getrecord/${type}/${vin}`);
  writeCache(vin, type, live);
  return true;
}

/* ================================================================
   VIN Validation (ISO 3779)
================================================================ */
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const VIN_MAP = Object.freeze({
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9, 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
});
function isPlausibleVinFormat(vin) { return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin); }
function vinCheckDigitOk(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const val = VIN_MAP[vin[i]];
    if (val == null) return false;
    sum += val * VIN_WEIGHTS[i];
  }
  const r = sum % 11;
  const expected = r === 10 ? "X" : String(r);
  return vin[8] === expected;
}
function validateVin(vinRaw) {
  const vin = (vinRaw || "").toUpperCase().trim();
  if (!isPlausibleVinFormat(vin)) return { ok: false, code: "format", msg: "VIN must be 17 characters (no I, O, Q)." };
  if (!vinCheckDigitOk(vin)) return { ok: false, code: "check_digit", msg: "VIN check digit is invalid." };
  return { ok: true, vin };
}

/* ================================================================
   Stripe Webhook
================================================================ */
const WH_LIVE = process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET;
const WH_TEST = process.env.STRIPE_WEBHOOK_SECRET_TEST || null;

app.get("/api/stripe-webhook", (_req, res) => res.status(200).send("ok"));

app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripeLive.webhooks.constructEvent(req.body, sig, WH_LIVE);
    } catch (e1) {
      if (WH_TEST) {
        try { event = stripeLive.webhooks.constructEvent(req.body, sig, WH_TEST); } 
        catch (e2) { return res.status(400).send("Webhook verification failed"); }
      } else { return res.status(400).send("Webhook verification failed"); }
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const sStripe = stripeForId(session.id);
        const lineItems = await sStripe.checkout.sessions.listLineItems(session.id, { limit: 10 });

        let creditsToAdd = 0;
        for (const li of lineItems.data) {
          const pid = li.price?.id;
          const qty = li.quantity || 1;
          const isBundle = pid === PRICE_10PACK || pid === PRICE_10PACK_TEST;
          creditsToAdd += qty * (isBundle ? CREDITS_PER_10PACK : CREDITS_PER_SINGLE);
        }

        const userId = session.metadata?.user_id || session.client_reference_id || null;
        const intent = session.metadata?.intent || "";
        const metaVin = (session.metadata?.vin || "").toUpperCase();
        const metaType = (session.metadata?.report_type || "carfax").toLowerCase();

        if (userId && creditsToAdd > 0) {
          const { data: existing } = await supabaseService.from("credits").select("balance").eq("user_id", userId).maybeSingle();
          if (existing) await supabaseService.from("credits").update({ balance: (existing.balance || 0) + creditsToAdd }).eq("user_id", userId);
          else await supabaseService.from("credits").insert({ user_id: userId, balance: creditsToAdd });
        }
        if (intent === "buy_report" && metaVin) {
          try { await fetchAndCacheReport(metaVin, metaType); } catch {}
        }
      }
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).send("Webhook handler error"); }
  }
);

/* ================================================================
   Middleware
================================================================ */
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: false }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

/* ================================================================
   Endpoints
================================================================ */

// Stripe Checkout
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { user_id: userIdFromBody, price_id, vin, report_type } = req.body || {};
    
    if (vin) {
      const v = validateVin(vin);
      if (!v.ok) return res.status(422).json({ error: "invalid_vin", reason: v.code, message: v.msg });
    }

    let userId = userIdFromBody;
    if (!userId) {
      const { user } = await getUser(req);
      if (user?.id) userId = user.id;
    }

    const isTenPack = price_id === "STRIPE_PRICE_10PACK" || price_id === "10pack";
    const priceLive = isTenPack ? PRICE_10PACK : PRICE_SINGLE;

    if (vin) {
      const type = (report_type || "carfax").toLowerCase();
      if (readCache((vin || "").toUpperCase(), type)) {
        return res.status(409).json({ alreadyCached: true, vin, report_type: type });
      }
    }

    const intent = vin ? "buy_report" : (isTenPack ? "buy_credits_bundle" : "buy_credit_single");
    const session = await stripeLive.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: priceLive, quantity: 1 }],
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&intent=${encodeURIComponent(intent)}${vin ? `&vin=${encodeURIComponent(vin)}` : ""}`,
      cancel_url: `${SITE_URL}/?checkout=cancel`,
      ...(userId ? { client_reference_id: userId } : {}),
      metadata: {
        ...(userId ? { user_id: userId } : {}),
        ...(vin ? { vin } : {}),
        ...(report_type ? { report_type } : {}),
        intent,
        purchase_kind: isTenPack ? "bundle" : "single",
      },
    });

    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: "Stripe error" }); }
});

// Credits
app.get("/api/credits/:user_id", async (req, res) => {
  try {
    const { data, error } = await supabaseService.from("credits").select("balance").eq("user_id", req.params.user_id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ balance: data?.balance ?? 0 });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// PayPal
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
const ppEnv = PAYPAL_ENV === "live"
    ? new paypalSdk.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new paypalSdk.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
const ppClient = new paypalSdk.core.PayPalHttpClient(ppEnv);

async function verifyPaypalCapture(captureId) {
  const req = new paypalSdk.payments.CapturesGetRequest(captureId);
  const res = await ppClient.execute(req);
  return res?.result; 
}

app.post("/api/paypal/create-order", async (_req, res) => {
  try {
    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "7.00" } }],
      application_context: { brand_name: "AutoVINReveal", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" },
    });
    const order = await ppClient.execute(request);
    res.json({ orderID: order.result.id });
  } catch { res.status(500).json({ error: "PayPal create-order failed" }); }
});

app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { orderID, user_id } = req.body || {};
    if (!orderID) return res.status(400).json({ error: "orderID required" });

    const capReq = new paypalSdk.orders.OrdersCaptureRequest(orderID);
    capReq.requestBody({});
    const capRes = await ppClient.execute(capReq);
    const cap = capRes?.result?.purchase_units?.[0]?.payments?.captures?.[0];
    const captureId = cap?.id || null;
    if (!captureId || cap?.status !== "COMPLETED") return res.status(400).json({ error: "Capture not completed" });

    if (user_id) {
      const { data: existing } = await supabaseService.from("credits").select("balance").eq("user_id", user_id).maybeSingle();
      if (existing) await supabaseService.from("credits").update({ balance: (existing.balance || 0) + 1 }).eq("user_id", user_id);
      else await supabaseService.from("credits").insert({ user_id, balance: 1 });
    }
    res.json({ ok: true, captureId });
  } catch { res.status(500).json({ error: "PayPal capture failed" }); }
});

// ✅ Main Report Logic with Auto-Refunds
app.post("/api/report", async (req, res) => {
  try {
    const { vin, state, plate, type = "carfax", as = "html", allowLive: allowLiveRaw, oneTimeSession } = req.body || {};
    const allowLive = allowLiveRaw !== false;

    // Resolve VIN
    let targetVin = (vin || "").trim().toUpperCase();
    if (!targetVin && state && plate) {
      try {
        const txt = await csGet(`${CS}/checkplate/${state}/${plate}`);
        const m = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
        if (m) targetVin = m[0];
      } catch { return res.status(400).json({ error: "plate_lookup_failed" }); }
    }
    if (!targetVin) return res.status(400).json({ error: "vin_required" });

    // Validate VIN
    const v = validateVin(targetVin);
    if (!v.ok) return res.status(422).json({ error: "invalid_vin", reason: v.code, message: v.msg });
    targetVin = v.vin;

    // Cache check
    let raw = readCache(targetVin, type.toLowerCase());

    // Live Fetch Logic
    if (!raw && allowLive) {
      let currentUser = null;

      // 1. DEDUCT CREDIT / CHECK PAYMENT
      if (oneTimeSession) {
        if (CONSUMED.has(oneTimeSession)) return res.status(409).json({ error: "receipt_used" });
        try {
          if (oneTimeSession.startsWith("pp_")) {
            const captureId = oneTimeSession.slice(3);
            const cap = await verifyPaypalCapture(captureId);
            if (cap?.status !== "COMPLETED") return res.status(402).json({ error: "payment_incomplete" });
          } else {
            const sStripe = stripeForId(oneTimeSession);
            const s = await sStripe.checkout.sessions.retrieve(oneTimeSession);
            if (s.payment_status !== "paid") return res.status(402).json({ error: "payment_incomplete" });
          }
          CONSUMED.add(oneTimeSession);
          saveConsumed();
        } catch { return res.status(400).json({ error: "receipt_invalid" }); }
      } else {
        const { token, user } = await getUser(req);
        if (user) {
          currentUser = user;
          const { error: rpcErr } = await supabaseForToken(token).rpc("use_credit_for_vin", { p_vin: targetVin, p_result_url: null });
          if (rpcErr) return res.status(402).json({ error: "insufficient_credits" });
        } else {
          return res.status(401).json({ error: "purchase_required" });
        }
      }

      // 2. FETCH REPORT
      try {
        const live = await csGet(`${CS}/getrecord/${type}/${targetVin}`);
        raw = live;
        writeCache(targetVin, type.toLowerCase(), raw);
      } catch (e) {
        // ⚠️ CRITICAL: FETCH FAILED. REFUND THE USER IMMEDIATELY.
        console.error(`Fetching ${targetVin} failed. Attempting refund.`);
        
        // Only refund credits users (oneTimeSession users just keep their token unused effectively, but for cleaner logic we might just fail)
        // If it was a credit user:
        if (currentUser) {
           await supabaseService.rpc('adjust_credits', {
              p_user: currentUser.id,
              p_delta: 1, // refund 1 credit
              p_reason: 'refund_api_failure',
              p_ref: targetVin
           });
           console.log(`Refunded 1 credit to user ${currentUser.id}`);
        } else if (oneTimeSession) {
           // If one-time session used, remove from CONSUMED so they can try again or use on another VIN
           CONSUMED.delete(oneTimeSession);
           saveConsumed();
        }

        const msg = String(e.message || "");
        if (msg.includes("CS_400") || msg.includes("CS_404") || /invalid.*vin|vin.*not.*found/i.test(msg)) {
           return res.status(422).json({ error: "invalid_vin", reason: "remote_reject", message: "VIN not found in database. Your credit has been refunded." });
        }
        return res.status(502).json({ error: "provider_error", message: "System error. Your credit has been refunded." });
      }
    }

    if (!raw) return res.status(404).json({ error: "not_found", message: "No report found." });

    const decoded = decodeReportBase64(raw);

    if (as === "pdf") {
      if (decoded.kind === "pdf") {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${targetVin}-${type}.pdf"`);
        return res.send(decoded.buffer);
      }
      if (decoded.kind === "html") {
         try {
           const form = new FormData();
           form.append("base64_content", Buffer.from(decoded.html, "utf8").toString("base64"));
           form.append("vin", targetVin);
           form.append("report_type", type);
           const pdf = await axios.post(`${CS}/pdf`, form, { headers: { ...H, ...form.getHeaders() }, responseType: "arraybuffer", timeout: 60000 });
           res.setHeader("Content-Type", "application/pdf");
           res.setHeader("Content-Disposition", `attachment; filename="${targetVin}-${type}.pdf"`);
           return res.send(Buffer.from(pdf.data));
         } catch { return res.status(502).json({ error: "pdf_convert_failed" }); }
      }
      return res.status(500).json({ error: "unsupported_content" });
    }

    if (decoded.kind === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(decoded.html);
    }
    return res.status(500).json({ error: "unsupported_content" });

  } catch (err) { return res.status(500).json({ error: "server_error" }); }
});

app.post("/api/email-report", async (req, res) => {
  try {
    if (!mailer) return res.status(500).json({ error: "email_not_configured" });
    const { to, vin, state, plate, type = "carfax" } = req.body || {};
    if (!to || !String(to).includes("@")) return res.status(400).json({ error: "invalid_to" });

    let targetVin = (vin || "").trim().toUpperCase();
    if (!targetVin && state && plate) {
       const txt = await csGet(`${CS}/checkplate/${state}/${plate}`);
       const m = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
       if (m) targetVin = m[0];
    }
    if (!targetVin) return res.status(400).json({ error: "vin_required" });

    const raw = readCache(targetVin, type.toLowerCase());
    if (!raw) return res.status(404).json({ error: "not_cached" });
    const decoded = decodeReportBase64(raw);

    const subject = `${type.toUpperCase()} report for ${targetVin}`;
    const attachments = [];
    if (decoded.kind === "pdf") attachments.push({ filename: `${targetVin}.pdf`, content: decoded.buffer });
    else if (decoded.kind === "html") attachments.push({ filename: `${targetVin}.html`, content: decoded.html });

    await mailer.sendMail({ from: SMTP_FROM, to, subject, text: `Attached is your report for VIN ${targetVin}.`, attachments });
    return res.json({ ok: true });
  } catch { return res.status(500).json({ error: "email_failed" }); }
});

const SHARE_FILE = path.join(__dirname, ".share_tokens.json");
let SHARE_TOKENS = {};
try { if (fs.existsSync(SHARE_FILE)) SHARE_TOKENS = JSON.parse(fs.readFileSync(SHARE_FILE, "utf8")); } catch {}
function saveShareTokens() { try { fs.writeFileSync(SHARE_FILE, JSON.stringify(SHARE_TOKENS, null, 2)); } catch {} }

app.post("/api/share", async (req, res) => {
  try {
    const { vin, type = "carfax" } = req.body || {};
    if (!vin) return res.status(400).json({ error: "vin required" });
    if (!readCache(vin.toUpperCase(), type.toLowerCase())) return res.status(404).json({ error: "not_cached" });

    const token = Buffer.from(crypto.randomUUID()).toString("base64url").replace(/=/g, "");
    const exp = Date.now() + 24 * 60 * 60 * 1000;
    SHARE_TOKENS[token] = { vin: vin.toUpperCase(), type: type.toLowerCase(), exp };
    saveShareTokens();
    res.json({ url: `${SITE_URL}/view/${token}`, expiresAt: exp });
  } catch { res.status(500).json({ error: "Failed to create share link" }); }
});

app.get("/view/:token", async (req, res) => {
  const t = req.params.token;
  const meta = SHARE_TOKENS[t];
  if (!meta || meta.exp <= Date.now()) return res.status(404).send("Link expired");
  const raw = readCache(meta.vin, meta.type);
  if (!raw) return res.status(404).send("Report not found");
  const decoded = decodeReportBase64(raw);
  if (decoded.kind === "html") { res.setHeader("Content-Type", "text/html"); return res.send(decoded.html); }
  if (decoded.kind === "pdf") { res.setHeader("Content-Type", "application/pdf"); return res.send(decoded.buffer); }
});

/* ================================================================
   Admin Routes
================================================================ */
function makeAdminToken() {
  const exp = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
  const payload = JSON.stringify({ exp });
  const sig = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  return Buffer.from(payload).toString("base64url") + "." + sig;
}
function verifyAdminToken(token) {
  if (!token) return false;
  const [p64, sig] = token.split(".");
  if (!p64 || !sig) return false;
  const payload = Buffer.from(p64, "base64url").toString("utf8");
  const expect = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  if (expect !== sig) return false;
  try { const obj = JSON.parse(payload); if (!obj?.exp || obj.exp < Date.now()) return false; } catch { return false; }
  return true;
}
function requireAdmin(req, res, next) {
  if (verifyAdminToken(req.cookies?.admin_session || "")) return next();
  return res.status(401).json({ error: "unauthorized" });
}

app.post("/api/admin/login", (req, res) => {
  if (req.body?.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "bad_password" });
  res.cookie("admin_session", makeAdminToken(), { httpOnly: true, secure: true, sameSite: "strict", maxAge: ADMIN_SESSION_TTL_SECONDS * 1000, path: "/" });
  res.json({ ok: true });
});

app.get("/api/admin/history", requireAdmin, async (req, res) => {
  try {
    const { data } = await supabaseService.from("vin_queries").select("id, user_id, vin, success, result_url, created_at").order("created_at", { ascending: false }).limit(200);
    res.json({ ok: true, rows: data || [] });
  } catch { res.status(500).json({ ok: false }); }
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

/* ================================================================
   Static Files & Boot
================================================================ */
// 1. Serve Static files
app.use(express.static(path.join(__dirname, "public")));

// 2. Catch-all for SPA/HTML (fixes the "OK" text error)
app.get("*", (req, res) => {
  if (req.accepts("html")) {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  } else {
    res.status(404).send("Not found");
  }
});

const server = app.listen(Number(PORT), HOST, () => {
  console.log(`\n🚀 Server is running!`);
  console.log(`-------------------------------------------`);
  console.log(`➡️  Local:   http://localhost:${PORT}`);
  console.log(`➡️  Network: http://127.0.0.1:${PORT}`);
  console.log(`-------------------------------------------\n`);
});