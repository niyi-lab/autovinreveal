/********************************************************************
 * AutoVINReveal Server – Stripe + PayPal + Supabase + Caching + Admin
 ********************************************************************/

import dotenv from "dotenv";
dotenv.config({ path: "/etc/secrets/.env" });
dotenv.config();

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
const SITE_URL = process.env.SITE_URL || `http://localhost:3000`;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || SITE_URL;
const FORCE_WWW = process.env.FORCE_WWW === "1";

const APP_SECRET = process.env.APP_SECRET || "please_change_me";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const ADMIN_SESSION_TTL_SECONDS = Number(
  process.env.ADMIN_SESSION_TTL_SECONDS || 60 * 60 * 12
);

/* ================================================================
   Security / redirects (except webhook)
================================================================ */
app.get(["/admin", "/admin/"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.set("trust proxy", 1);
const WEBHOOK_PATHS = new Set(["/api/stripe-webhook", "/api/stripe-webhook/"]);

app.use((req, res, next) => {
  if (WEBHOOK_PATHS.has(req.path)) return next();

  // Force HTTPS behind proxy
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
const stripeLive = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});
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
    if (!STRIPE_TEST_SECRET_KEY)
      throw new Error("Test session but STRIPE_TEST_SECRET_KEY not set.");
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
   Email (Nodemailer via SMTP)
================================================================ */
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = process.env.SMTP_SECURE !== "0"; // default true
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM =
  process.env.SMTP_FROM || "AutoVINReveal <autovinreveal@gmail.com>";

let mailer = null;
if (SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  // 🔍 Check SMTP connection on boot
  mailer
    .verify()
    .then(() => {
      console.log("✅ SMTP mailer is ready");
    })
    .catch((err) => {
      console.error("❌ SMTP verify failed:", err);
    });
} else {
  console.warn(
    "⚠️ SMTP_USER/SMTP_PASS not set. /api/email-report will be disabled."
  );
}

/* ================================================================
   CarSimulcast API (hardened)
================================================================ */
const CS = "https://connect.carsimulcast.com";
const KEY = process.env.API_KEY;
const SECRET = process.env.API_SECRET;
const H = { "API-KEY": KEY, "API-SECRET": SECRET };

// ✅ Hardened: surface HTTP errors / hints so we can respond 422 for bad VINs.
async function csGet(url) {
  try {
    const r = await axios.get(url, {
      headers: H,
      responseType: "text",
      timeout: 30000,
      validateStatus: () => true, // don't throw; we handle status codes
    });
    if (r.status >= 400) {
      const body = String(r.data || "");
      const hint = body.slice(0, 200).toLowerCase();
      throw new Error(`CS_${r.status}:${hint}`);
    }
    return r.data; // base64 (gzipped HTML OR raw HTML-base64 OR raw PDF-base64)
  } catch (err) {
    const msg = String(err?.message || "cs-error");
    throw new Error(`CS_ERROR:${msg}`);
  }
}

/* ================================================================
   Cache / helpers
================================================================ */
const CACHE_DIR = path.join(__dirname, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const ck = (vin, type) => path.join(CACHE_DIR, `${vin}-${type}.b64`);
const readCache = (vin, type) =>
  fs.existsSync(ck(vin, type)) ? fs.readFileSync(ck(vin, type), "utf8") : null;
const writeCache = (vin, type, data) =>
  fs.writeFileSync(ck(vin, type), data, "utf8");

const CONSUMED_FILE = path.join(__dirname, ".consumed_sessions.json");
let CONSUMED = new Set();
try {
  if (fs.existsSync(CONSUMED_FILE)) {
    CONSUMED = new Set(JSON.parse(fs.readFileSync(CONSUMED_FILE, "utf8")));
  }
} catch {}
function saveConsumed() {
  try {
    fs.writeFileSync(CONSUMED_FILE, JSON.stringify([...CONSUMED], null, 2));
  } catch {}
}

function decodeReportBase64(rawB64) {
  const buf = Buffer.from(rawB64, "base64");
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return { kind: "html", html: gunzipSync(buf).toString("utf8") };
    } catch {
      return { kind: "unknown", buffer: buf, error: "gunzip-failed" };
    }
  }
  if (buf.slice(0, 5).toString() === "%PDF-")
    return { kind: "pdf", buffer: buf };
  const asText = buf.toString("utf8");
  if (/<!DOCTYPE html|<html[\s>]/i.test(asText.slice(0, 2048))) {
    return { kind: "html", html: asText };
  }
  return { kind: "unknown", buffer: buf };
}

async function fetchAndCacheReport(vin, type = "carfax") {
  const live = await csGet(`${CS}/getrecord/${type}/${vin}`);
  writeCache(vin, type, live);
  return true;
}

/* ================================================================
   ✅ VIN validation (ISO 3779: charset + check digit)
================================================================ */
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const VIN_MAP = Object.freeze({
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
});
function isPlausibleVinFormat(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}
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
  if (!isPlausibleVinFormat(vin)) {
    return {
      ok: false,
      code: "format",
      msg: "VIN must be 17 characters (no I, O, Q).",
    };
  }
  if (!vinCheckDigitOk(vin)) {
    return {
      ok: false,
      code: "check_digit",
      msg: "VIN check digit is invalid. Please re-check.",
    };
  }
  return { ok: true, vin };
}

/* ================================================================
   Stripe webhook (raw)
================================================================ */
const WH_LIVE =
  process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET;
const WH_TEST = process.env.STRIPE_WEBHOOK_SECRET_TEST || null;

app.get(["/api/stripe-webhook", "/api/stripe-webhook/"], (_req, res) =>
  res.status(200).send("ok")
);

app.post(
  ["/api/stripe-webhook", "/api/stripe-webhook/"],
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripeLive.webhooks.constructEvent(req.body, sig, WH_LIVE);
    } catch (e1) {
      if (WH_TEST) {
        try {
          event = stripeLive.webhooks.constructEvent(req.body, sig, WH_TEST);
        } catch (e2) {
          return res.status(400).send("Webhook signature verification failed");
        }
      } else {
        return res.status(400).send("Webhook signature verification failed");
      }
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const sStripe = stripeForId(session.id);
        const lineItems = await sStripe.checkout.sessions.listLineItems(
          session.id,
          { limit: 10 }
        );

        let creditsToAdd = 0;
        for (const li of lineItems.data) {
          const pid = li.price?.id;
          const qty = li.quantity || 1;
          if (pid === PRICE_SINGLE || pid === PRICE_SINGLE_TEST) {
            creditsToAdd += qty * CREDITS_PER_SINGLE;
          } else if (pid === PRICE_10PACK || pid === PRICE_10PACK_TEST) {
            creditsToAdd += qty * CREDITS_PER_10PACK;
          } else {
            creditsToAdd += qty * CREDITS_PER_SINGLE;
          }
        }

        const userId =
          session.metadata?.user_id || session.client_reference_id || null;
        const intent = session.metadata?.intent || "";
        const metaVin = (session.metadata?.vin || "").toUpperCase();
        const metaType = (
          session.metadata?.report_type || "carfax"
        ).toLowerCase();

        if (userId && creditsToAdd > 0) {
          const { data: existing } = await supabaseService
            .from("credits")
            .select("balance")
            .eq("user_id", userId)
            .maybeSingle();

          if (existing) {
            await supabaseService
              .from("credits")
              .update({ balance: (existing.balance || 0) + creditsToAdd })
              .eq("user_id", userId);
          } else {
            await supabaseService
              .from("credits")
              .insert({ user_id: userId, balance: creditsToAdd });
          }
        }

        if (intent === "buy_report" && metaVin) {
          try {
            await fetchAndCacheReport(metaVin, metaType);
          } catch {}
        }
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).send("Webhook handler error");
    }
  }
);

/* ================================================================
   Normal middleware
================================================================ */
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: false }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

/* ================================================================
   Stripe checkout session  (✅ validate VIN before creating session)
================================================================ */
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const {
      user_id: userIdFromBody,
      price_id,
      vin,
      report_type,
    } = req.body || {};

    // 🔒 Validate VIN if provided (prevents charging for bogus VINs)
    if (vin) {
      const v = validateVin(vin);
      if (!v.ok) {
        return res.status(422).json({
          error: "invalid_vin",
          reason: v.code,
          message: v.msg,
        });
      }
    }

    let userId = userIdFromBody;
    if (!userId) {
      const { user } = await getUser(req);
      if (user?.id) userId = user.id;
    }

    const isTenPack =
      price_id === "STRIPE_PRICE_10PACK" || price_id === "10pack";
    const priceLive = isTenPack ? PRICE_10PACK : PRICE_SINGLE;

    if (vin) {
      const type = (report_type || "carfax").toLowerCase();
      const cached = readCache((vin || "").toUpperCase(), type);
      if (cached) {
        return res.status(409).json({
          alreadyCached: true,
          vin,
          report_type: type,
        });
      }
    }

    const intent = vin
      ? "buy_report"
      : isTenPack
      ? "buy_credits_bundle"
      : "buy_credit_single";

    const session = await stripeLive.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: priceLive, quantity: 1 }],
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&intent=${encodeURIComponent(
        intent
      )}${vin ? `&vin=${encodeURIComponent(vin)}` : ""}`,
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
  } catch (err) {
    res.status(500).json({ error: "Stripe error" });
  }
});

/* ================================================================
   Stripe finalize safety-net
================================================================ */
app.post("/api/checkout/finalize", async (req, res) => {
  try {
    const { session_id } = req.body || {};
    if (!session_id)
      return res.status(400).json({ error: "session_id required" });

    const sStripe = stripeForId(session_id);
    const session = await sStripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: "Payment not completed" });
    }

    const lineItems = await sStripe.checkout.sessions.listLineItems(
      session_id,
      { limit: 10 }
    );
    let creditsToAdd = 0;
    for (const li of lineItems.data) {
      const pid = li.price?.id;
      const qty = li.quantity || 1;
      if (pid === PRICE_SINGLE || pid === PRICE_SINGLE_TEST) {
        creditsToAdd += qty * CREDITS_PER_SINGLE;
      } else if (pid === PRICE_10PACK || pid === PRICE_10PACK_TEST) {
        creditsToAdd += qty * CREDITS_PER_10PACK;
      } else {
        creditsToAdd += qty * CREDITS_PER_SINGLE;
      }
    }

    const userId =
      session.metadata?.user_id || session.client_reference_id || null;
    if (userId && creditsToAdd > 0) {
      const { data: existing } = await supabaseService
        .from("credits")
        .select("balance")
        .eq("user_id", userId)
        .maybeSingle();

      if (existing) {
        await supabaseService
          .from("credits")
          .update({ balance: (existing.balance || 0) + creditsToAdd })
          .eq("user_id", userId);
      } else {
        await supabaseService
          .from("credits")
          .insert({ user_id: userId, balance: creditsToAdd });
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "finalize failed" });
  }
});

/* ================================================================
   Credits API
================================================================ */
app.get("/api/credits/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;
    const { data, error } = await supabaseService
      .from("credits")
      .select("balance")
      .eq("user_id", user_id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ balance: data?.balance ?? 0 });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ================================================================
   PayPal
================================================================ */
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
const ppEnv =
  PAYPAL_ENV === "live"
    ? new paypalSdk.core.LiveEnvironment(
        process.env.PAYPAL_CLIENT_ID,
        process.env.PAYPAL_CLIENT_SECRET
      )
    : new paypalSdk.core.SandboxEnvironment(
        process.env.PAYPAL_CLIENT_ID,
        process.env.PAYPAL_CLIENT_SECRET
      );
const ppClient = new paypalSdk.core.PayPalHttpClient(ppEnv);

async function verifyPaypalCapture(captureId) {
  const req = new paypalSdk.payments.CapturesGetRequest(captureId);
  const res = await ppClient.execute(req);
  return res?.result; // COMPLETED
}

app.post("/api/paypal/create-order", async (_req, res) => {
  try {
    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "7.00" } }],
      application_context: {
        brand_name: "AutoVINReveal",
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
      },
    });
    const order = await ppClient.execute(request);
    res.json({ orderID: order.result.id });
  } catch (e) {
    res.status(500).json({ error: "PayPal create-order failed" });
  }
});

app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { orderID, user_id } = req.body || {};
    if (!orderID) return res.status(400).json({ error: "orderID required" });

    const capReq = new paypalSdk.orders.OrdersCaptureRequest(orderID);
    capReq.requestBody({});
    const capRes = await ppClient.execute(capReq);

    const unit = capRes?.result?.purchase_units?.[0];
    const cap = unit?.payments?.captures?.[0];
    const captureId = cap?.id || null;
    const status = cap?.status || capRes?.result?.status;

    if (!captureId || status !== "COMPLETED") {
      return res.status(400).json({ error: "Capture not completed", status });
    }

    if (user_id) {
      const { data: existing } = await supabaseService
        .from("credits")
        .select("balance")
        .eq("user_id", user_id)
        .maybeSingle();
      if (existing) {
        await supabaseService
          .from("credits")
          .update({ balance: (existing.balance || 0) + 1 })
          .eq("user_id", user_id);
      } else {
        await supabaseService.from("credits").insert({ user_id, balance: 1 });
      }
    }

    res.json({ ok: true, captureId });
  } catch (e) {
    res.status(500).json({ error: "PayPal capture failed" });
  }
});

/* ================================================================
   /api/check – see if cached (✅ now rejects invalid VINs)
================================================================ */
app.post("/api/check", async (req, res) => {
  try {
    const { vin, state, plate, type = "carfax" } = req.body || {};
    let targetVin = (vin || "").trim().toUpperCase();

    if (!targetVin && state && plate) {
      const txt = await csGet(`${CS}/checkplate/${state}/${plate}`);
      const m = txt?.match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m) targetVin = m[0];
    }
    if (!targetVin) return res.json({ ok: true, cached: false });

    const v = validateVin(targetVin);
    if (!v.ok) {
      return res.status(422).json({
        ok: false,
        error: "invalid_vin",
        reason: v.code,
      });
    }

    const raw = readCache(v.vin, type.toLowerCase());
    return res.json({
      ok: true,
      cached: !!raw,
      vin: v.vin,
      type: type.toLowerCase(),
    });
  } catch (e) {
    return res.status(200).json({ ok: false, cached: false });
  }
});

/* ================================================================
   Report API (✅ validates VIN & surfaces provider errors)
================================================================ */
app.post("/api/report", async (req, res) => {
  try {
    const {
      vin,
      state,
      plate,
      type = "carfax",
      as = "html",
      allowLive: allowLiveRaw,
      oneTimeSession,
    } = req.body || {};
    const allowLive = allowLiveRaw !== false;

    // Resolve VIN
    let targetVin = (vin || "").trim().toUpperCase();
    if (!targetVin && state && plate) {
      const txt = await csGet(`${CS}/checkplate/${state}/${plate}`);
      const m = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m) targetVin = m[0];
    }
    if (!targetVin) {
      return res.status(400).json({
        error: "vin_required",
        message: "VIN or State+Plate required",
      });
    }

    // ✅ Validate VIN here (prevents spending a credit / charging on invalid VINs)
    const v = validateVin(targetVin);
    if (!v.ok) {
      return res.status(422).json({
        error: "invalid_vin",
        reason: v.code,
        message: v.msg,
      });
    }
    targetVin = v.vin;

    // Cache first
    let raw = readCache(targetVin, type.toLowerCase());

    // Not cached: optionally live fetch (credits if user or one-time receipt)
    if (!raw && allowLive) {
      // Payment/credit checks...
      if (oneTimeSession) {
        if (CONSUMED.has(oneTimeSession)) {
          return res.status(409).json({ error: "receipt_used" });
        }
        try {
          if (oneTimeSession.startsWith("pp_")) {
            const captureId = oneTimeSession.slice(3);
            const cap = await verifyPaypalCapture(captureId);
            if (cap?.status !== "COMPLETED") {
              return res.status(402).json({ error: "payment_incomplete" });
            }
          } else {
            const sStripe = stripeForId(oneTimeSession);
            const s = await sStripe.checkout.sessions.retrieve(oneTimeSession);
            if (s.payment_status !== "paid") {
              return res.status(402).json({ error: "payment_incomplete" });
            }
          }
          CONSUMED.add(oneTimeSession);
          saveConsumed();
        } catch {
          return res.status(400).json({ error: "receipt_invalid" });
        }
      } else {
        const { token, user } = await getUser(req);
        if (user) {
          const supabaseUser = supabaseForToken(token);
          const { error: rpcErr } = await supabaseUser.rpc(
            "use_credit_for_vin",
            { p_vin: targetVin, p_result_url: null }
          );
          if (rpcErr) {
            return res.status(402).json({ error: "insufficient_credits" });
          }
        } else {
          return res.status(401).json({ error: "purchase_required" });
        }
      }

      // ✅ Call CarSimulcast and interpret errors
      try {
        const live = await csGet(`${CS}/getrecord/${type}/${targetVin}`);
        raw = live;
        writeCache(targetVin, type.toLowerCase(), raw);
      } catch (e) {
        const msg = String(e.message || "");
        if (
          msg.includes("CS_400") ||
          msg.includes("CS_404") ||
          /invalid.*vin|vin.*not.*found/i.test(msg)
        ) {
          return res.status(422).json({
            error: "invalid_vin",
            reason: "remote_reject",
            message: "The provider rejected this VIN as invalid or not found.",
          });
        }
        return res.status(502).json({
          error: "provider_error",
          message: "Upstream error fetching report. Please try again.",
        });
      }
    }

    if (!raw) {
      return res.status(404).json({
        error: "not_found",
        message: "No cached or archive report found.",
      });
    }

    const decoded = decodeReportBase64(raw);

    if (as === "pdf") {
      if (decoded.kind === "pdf") {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${targetVin}-${type}.pdf"`
        );
        return res.send(decoded.buffer);
      }
      if (decoded.kind === "html") {
        try {
          const form = new FormData();
          form.append(
            "base64_content",
            Buffer.from(decoded.html, "utf8").toString("base64")
          );
          form.append("vin", targetVin);
          form.append("report_type", type);
          const pdf = await axios.post(`${CS}/pdf`, form, {
            headers: { ...H, ...form.getHeaders() },
            responseType: "arraybuffer",
            timeout: 60000,
          });
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${targetVin}-${type}.pdf"`
          );
          return res.send(Buffer.from(pdf.data));
        } catch {
          return res.status(502).json({ error: "pdf_convert_failed" });
        }
      }
      return res.status(500).json({ error: "unsupported_content" });
    }

    if (decoded.kind === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(decoded.html);
    }
    if (decoded.kind === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${targetVin}-${type}.pdf"`
      );
      return res.send(decoded.buffer);
    }
    return res.status(500).json({ error: "unsupported_content" });
  } catch (err) {
    return res.status(500).json({ error: "server_error" });
  }
});

/* ================================================================
   Email report (uses cached report only)
================================================================ */
app.post("/api/email-report", async (req, res) => {
  try {
    if (!mailer) {
      return res.status(500).json({
        error: "email_not_configured",
        message: "Email transport is not configured on server.",
      });
    }

    const { to, vin, state, plate, type = "carfax" } = req.body || {};

    if (!to || !String(to).includes("@")) {
      return res.status(400).json({
        error: "invalid_to",
        message: "Valid recipient email is required.",
      });
    }

    // Resolve VIN (VIN or State+Plate, same pattern as /api/report)
    let targetVin = (vin || "").trim().toUpperCase();
    if (!targetVin && state && plate) {
      try {
        const txt = await csGet(`${CS}/checkplate/${state}/${plate}`);
        const m = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
        if (m) targetVin = m[0];
      } catch (e) {
        return res.status(400).json({
          error: "plate_lookup_failed",
          message: "Could not resolve VIN from plate.",
        });
      }
    }

    if (!targetVin) {
      return res.status(400).json({
        error: "vin_required",
        message: "VIN or State+Plate required to email report.",
      });
    }

    // Validate VIN
    const v = validateVin(targetVin);
    if (!v.ok) {
      return res.status(422).json({
        error: "invalid_vin",
        reason: v.code,
        message: v.msg,
      });
    }
    targetVin = v.vin;

    // Only use cached report; do NOT fetch live / consume credits here
    const t = (type || "carfax").toLowerCase();
    const raw = readCache(targetVin, t);

    if (!raw) {
      return res.status(404).json({
        error: "not_cached",
        message: "This report is not cached yet. Open it once before emailing.",
      });
    }

    const decoded = decodeReportBase64(raw);

    const subject = `${t.toUpperCase()} report for ${targetVin}`;
    const text = [
      `Here is your ${t.toUpperCase()} vehicle history report for VIN ${targetVin}.`,
      "",
      "If you have any questions, just reply to this email.",
      "",
      "— AutoVINReveal",
    ].join("\n");

    const attachments = [];
    if (decoded.kind === "pdf") {
      attachments.push({
        filename: `${targetVin}-${t}.pdf`,
        content: decoded.buffer,
      });
    } else if (decoded.kind === "html") {
      attachments.push({
        filename: `${targetVin}-${t}.html`,
        content: decoded.html,
      });
    } else {
      return res.status(500).json({
        error: "unsupported_content",
        message: "Unsupported report format for emailing.",
      });
    }

    await mailer.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      text,
      attachments,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("email-report error:", e);
    return res.status(500).json({
      error: "email_failed",
      message: e?.message || "Failed to send email.",
    });
  }
});

/* ================================================================
   Share links (cache-only)
================================================================ */
const SHARE_FILE = path.join(__dirname, ".share_tokens.json");
let SHARE_TOKENS = {};
try {
  if (fs.existsSync(SHARE_FILE)) {
    SHARE_TOKENS = JSON.parse(fs.readFileSync(SHARE_FILE, "utf8"));
  }
} catch {}
function saveShareTokens() {
  try {
    fs.writeFileSync(SHARE_FILE, JSON.stringify(SHARE_TOKENS, null, 2));
  } catch {}
}
function makeToken() {
  return Buffer.from(crypto.randomUUID())
    .toString("base64url")
    .replace(/=/g, "");
}
function pruneShareTokens() {
  const now = Date.now();
  let changed = false;
  for (const [tok, meta] of Object.entries(SHARE_TOKENS)) {
    if (!meta || meta.exp <= now) {
      delete SHARE_TOKENS[tok];
      changed = true;
    }
  }
  if (changed) saveShareTokens();
}
setInterval(pruneShareTokens, 60 * 60 * 1000);

app.post("/api/share", async (req, res) => {
  try {
    const { vin, type = "carfax" } = req.body || {};
    if (!vin) return res.status(400).json({ error: "vin required" });

    const raw = readCache(vin.toUpperCase(), type.toLowerCase());
    if (!raw) {
      return res.status(404).json({
        error: "Report not cached yet. Open it once first.",
      });
    }

    const token = makeToken();
    const exp = Date.now() + 24 * 60 * 60 * 1000;
    SHARE_TOKENS[token] = {
      vin: vin.toUpperCase(),
      type: type.toLowerCase(),
      exp,
    };
    saveShareTokens();

    const url = `${SITE_URL}/view/${token}`;
    res.json({ url, expiresAt: exp });
  } catch {
    res.status(500).json({ error: "Failed to create share link" });
  }
});

app.get("/view/:token", async (req, res) => {
  pruneShareTokens();
  const t = req.params.token;
  const meta = SHARE_TOKENS[t];
  if (!meta || meta.exp <= Date.now()) {
    return res.status(404).send("Link expired or invalid");
  }

  const raw = readCache(meta.vin, meta.type);
  if (!raw) return res.status(404).send("Report not found in cache");

  const decoded = decodeReportBase64(raw);
  if (decoded.kind === "html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(decoded.html);
  }
  if (decoded.kind === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${meta.vin}-${meta.type}.pdf"`
    );
    return res.send(decoded.buffer);
  }
  return res.status(500).send("Unsupported report content.");
});

/* ================================================================
   ADMIN – token in cookie, admin-only endpoints
================================================================ */
function makeAdminToken() {
  const exp = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
  const payload = JSON.stringify({ exp });
  const sig = crypto
    .createHmac("sha256", APP_SECRET)
    .update(payload)
    .digest("base64url");
  return Buffer.from(payload).toString("base64url") + "." + sig;
}
function verifyAdminToken(token) {
  if (!token) return false;
  const [p64, sig] = token.split(".");
  if (!p64 || !sig) return false;
  const payload = Buffer.from(p64, "base64url").toString("utf8");
  const expect = crypto
    .createHmac("sha256", APP_SECRET)
    .update(payload)
    .digest("base64url");
  if (expect !== sig) return false;
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    return false;
  }
  if (!obj?.exp || obj.exp < Date.now()) return false;
  return true;
}
function requireAdmin(req, res, next) {
  const t = req.cookies?.admin_session || "";
  if (verifyAdminToken(t)) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// Admin login/logout/whoami
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "bad_password" });
  }
  const token = makeAdminToken();
  res.cookie("admin_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: ADMIN_SESSION_TTL_SECONDS * 1000,
    path: "/",
  });
  return res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("admin_session", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/admin/whoami", (req, res) => {
  const ok = verifyAdminToken(req.cookies?.admin_session || "");
  res.json({ admin: !!ok });
});

// Admin: list cache
app.get("/api/admin/cache", requireAdmin, async (req, res) => {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".b64"));
    const rows = files
      .map((f) => {
        const full = path.join(CACHE_DIR, f);
        const stat = fs.statSync(full);
        const [vin, typeB64] = f.replace(".b64", "").split("-");
        return {
          vin,
          type: typeB64,
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "read_failed" });
  }
});

// Admin: open/download cached OR fetch live (no cost)
app.get("/api/admin/open", requireAdmin, async (req, res) => {
  try {
    const vin = (req.query.vin || "").toUpperCase();
    const type = (req.query.type || "carfax").toLowerCase();
    const as = (req.query.as || "html").toLowerCase(); // html|pdf
    const fetchLive = req.query.fetch === "1";

    if (!vin) return res.status(400).send("vin required");

    let raw = readCache(vin, type);

    if (!raw && fetchLive) {
      await fetchAndCacheReport(vin, type);
      raw = readCache(vin, type);
    }
    if (!raw) return res.status(404).send("not cached");

    const decoded = decodeReportBase64(raw);

    if (as === "pdf") {
      if (decoded.kind === "pdf") {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${vin}-${type}.pdf"`
        );
        return res.send(decoded.buffer);
      }
      if (decoded.kind === "html") {
        try {
          const form = new FormData();
          form.append(
            "base64_content",
            Buffer.from(decoded.html, "utf8").toString("base64")
          );
          form.append("vin", vin);
          form.append("report_type", type);
          const pdf = await axios.post(`${CS}/pdf`, form, {
            headers: { ...H, ...form.getHeaders() },
            responseType: "arraybuffer",
            timeout: 60000,
          });
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${vin}-${type}.pdf"`
          );
          return res.send(Buffer.from(pdf.data));
        } catch {
          return res.status(502).send("pdf convert failed");
        }
      }
      return res.status(500).send("unsupported");
    }

    if (decoded.kind === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(decoded.html);
    }
    if (decoded.kind === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${vin}-${type}.pdf"`
      );
      return res.send(decoded.buffer);
    }
    return res.status(500).send("unsupported");
  } catch (e) {
    return res.status(500).send("admin open error");
  }
});

// Admin: VIN history (latest N)
app.get("/api/admin/history", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 200), 500);
    const { data, error } = await supabaseService
      .from("vin_queries")
      .select("id, user_id, vin, success, result_url, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, rows: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: "history_failed" });
  }
});

/* ================================================================
   Optional: public VIN validator endpoint for instant UX
================================================================ */
app.get("/api/vin/validate/:vin", (req, res) => {
  const v = validateVin(req.params.vin);
  if (!v.ok) {
    return res.status(422).json({
      ok: false,
      reason: v.code,
      message: v.msg,
    });
  }
  return res.json({ ok: true, vin: v.vin });
});

/* ================================================================
   Static + explicit /admin route
================================================================ */
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use(express.static(path.join(__dirname, "public")));

/* ================================================================
   Boot
================================================================ */


const server = app.listen(Number(PORT), HOST, () => {
  const addr = server.address();
  const where =
    typeof addr === "string" ? addr : `${addr.address}:${addr.port}`;
  console.log(`✅ Server listening on ${where}`);
  console.log(`   Try:  http://localhost:${PORT}`);
  console.log(`         http://127.0.0.1:${PORT}`);
});

// optional, keep-alive tuning
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
