/********************************************************************
 * AutoVINReveal Server
 * ORIGINAL FIXES (from prior session):
 *   #1  — consumed_sessions moved from disk to Supabase DB
 *   #2  — share_tokens moved from disk to Supabase DB
 *   #3  — /api/credits/:user_id now requires auth + ownership check
 *   #5  — webhook & PayPal credit updates use atomic add_credits RPC
 *   #6  — justCharged replaced with DB-backed pending_charges
 *   #7  — server throws on startup if APP_SECRET is default value
 *   #17 — PayPal create-order/capture-order support single/5pack/10pack
 *
 * PREVIOUS FIXES:
 *   #F  — paypalClient renamed to ppClient everywhere (ReferenceError crash fix)
 *   #G  — create-order destructures `package` not `package_type` (key mismatch fix)
 *   #H  — plate/state sanitised to alphanumeric before upstream URL interpolation
 *   #I  — reconcileStalePendingCharges threshold raised from 5 min → 15 min
 *   #J  — PayPal order tracking: invoice_id, custom_id, items, sku, description
 *   #K  — Added amount.breakdown.item_total to PayPal order body.
 *   #L  — invoice_id middle segment capped at 60 chars.
 *
 * FIXES IN THIS VERSION:
 *   FIX-1 — Admin timingSafeEqual no longer short-circuited by plain === comparison.
 *            The redundant `&& provided === expected` was leaking timing information
 *            and defeating the entire purpose of timingSafeEqual.
 *
 *   FIX-2 — markSessionConsumed now throws SESSION_ALREADY_CONSUMED on a duplicate-key
 *            error from the DB, making the isConsumed check + mark atomic via the
 *            unique constraint rather than a racy read-then-write sequence.
 *            The report route catches this error and returns 400 receipt_already_used.
 *
 *   FIX-3 — createPendingCharge is now called BEFORE use_credit_for_vin so that a
 *            crash between the two operations leaves a recoverable pending record.
 *            Previously a crash after the RPC deducted the credit but before the
 *            pending row was inserted would silently lose the user's credit.
 *            If use_credit_for_vin fails (insufficient credits) the pending row is
 *            immediately cleaned up and a 402 is returned as before.
 *
 *   FIX-4 — getReportData now filters by report type in the DB query so a CARFAX
 *            lookup never returns a cached AutoCheck report for the same VIN.
 *            The upsert in the report route stores the type column and uses
 *            (user_id, vin, type) as the conflict target.
 *
 *   FIX-5 — paypalCaptureLimiter now also applied to /api/paypal/create-order.
 *            Previously create-order was unprotected, allowing unlimited PayPal
 *            API calls against the server's credentials.
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
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

/* ================================================================
   Config (env)
================================================================ */
const SITE_URL       = process.env.SITE_URL     || `http://localhost:${PORT}`;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || SITE_URL;
const FORCE_WWW      = process.env.FORCE_WWW === "1";

const APP_SECRET     = process.env.APP_SECRET   || "change_me_in_env_file";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const ADMIN_SESSION_TTL_SECONDS = Number(process.env.ADMIN_SESSION_TTL_SECONDS || 60 * 60 * 12);

if (!APP_SECRET || APP_SECRET === "change_me_in_env_file") {
  throw new Error(
    "FATAL: APP_SECRET must be set to a strong random secret in your environment variables. " +
    "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}

/* ================================================================
   Security / redirects
================================================================ */
app.set("trust proxy", 1);
const WEBHOOK_PATHS = new Set(["/api/stripe-webhook", "/api/stripe-webhook/"]);

app.use((req, res, next) => {
  if (WEBHOOK_PATHS.has(req.path)) return next();
  if (process.env.NODE_ENV === "production") {
    const xfProto = req.get("x-forwarded-proto");
    if (!req.secure && xfProto !== "https") {
      return res.redirect(308, `https://${req.headers.host}${req.url}`);
    }
  }
  if (FORCE_WWW && req.headers.host && !req.headers.host.startsWith("www.")) {
    return res.redirect(308, `https://www.${req.headers.host}${req.url}`);
  }
  next();
});

app.use((_req, res, next) => {
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

const PRICE_SINGLE  = process.env.STRIPE_PRICE_SINGLE;
const PRICE_5PACK   = process.env.STRIPE_PRICE_5PACK;
const PRICE_10PACK  = process.env.STRIPE_PRICE_10PACK;

const CREDITS_PER_SINGLE  = Number(process.env.CREDITS_PER_SINGLE  || "1");
const CREDITS_PER_5PACK   = Number(process.env.CREDITS_PER_5PACK   || "5");
const CREDITS_PER_10PACK  = Number(process.env.CREDITS_PER_10PACK  || "10");

function stripeForId(id) {
  const isTest = typeof id === "string" && id.startsWith("cs_test_");
  if (isTest) {
    if (!STRIPE_TEST_SECRET_KEY) throw new Error("Test session but STRIPE_TEST_SECRET_KEY not set.");
    return new Stripe(STRIPE_TEST_SECRET_KEY, { apiVersion: "2024-06-20" });
  }
  return stripeLive;
}

/* ================================================================
   PayPal package config (single source of truth)
================================================================ */
const PAYPAL_PACKAGE_CONFIG = {
  single:   { amount: "6.00",  credits: 1  },
  "5pack":  { amount: "25.00", credits: 5  },
  "10pack": { amount: "40.00", credits: 10 },
};

function resolvePaypalPackage(pkg) {
  return PAYPAL_PACKAGE_CONFIG[pkg] || PAYPAL_PACKAGE_CONFIG["single"];
}

/* ================================================================
   Supabase
================================================================ */
const SUPABASE_URL      = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY  = process.env.SERVICE_ROLE_KEY;

const supabaseAnon     = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const supabaseService  = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
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
const SMTP_HOST   = process.env.SMTP_HOST   || "smtp.gmail.com";
const SMTP_PORT   = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = process.env.SMTP_SECURE !== "0";
const SMTP_USER   = process.env.SMTP_USER;
const SMTP_PASS   = process.env.SMTP_PASS;
const SMTP_FROM   = process.env.SMTP_FROM   || "AutoVINReveal <autovinreveal@gmail.com>";

let mailer = null;
if (SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  mailer.verify()
    .then(()  => console.log("✅ SMTP mailer ready"))
    .catch(e  => console.error("❌ SMTP failed:", e));
} else {
  console.warn("⚠️  SMTP not configured. Emails will fail.");
}

/* ================================================================
   CarSimulcast API
================================================================ */
const CS     = "https://connect.carsimulcast.com";
const KEY    = process.env.API_KEY;
const SECRET = process.env.API_SECRET;
const H      = { "API-KEY": KEY, "API-SECRET": SECRET };

async function csGet(url) {
  try {
    const r = await axios.get(url, {
      headers: H, responseType: "text", timeout: 30000,
      validateStatus: () => true,
    });
    if (r.status >= 400) {
      const hint = String(r.data || "").slice(0, 200).toLowerCase();
      throw new Error(`CS_${r.status}:${hint}`);
    }
    return r.data;
  } catch (err) {
    throw new Error(`CS_ERROR:${String(err?.message || "cs-error")}`);
  }
}

/* ================================================================
   Cache / Helpers
================================================================ */
const CACHE_DIR = path.join(__dirname, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const ck = (vin, type) => path.join(CACHE_DIR, `${vin}-${type}.b64`);

const writeCache = (vin, type, data) => fs.writeFileSync(ck(vin, type), data, "utf8");

const REPORT_TTL_DAYS = 30;
const MAX_AGE_MS      = REPORT_TTL_DAYS * 24 * 60 * 60 * 1000;

// FIX-4: DB query now filters by `type` so a CARFAX lookup never returns
// a cached AutoCheck report (or vice versa) for the same VIN.
async function getReportData(vin, type) {
  const v = (vin  || "").toUpperCase();
  const t = (type || "").toLowerCase();

  const filePath = ck(v, t);
  if (fs.existsSync(filePath)) {
    try {
      const stats = fs.statSync(filePath);
      if (Date.now() - stats.mtimeMs < MAX_AGE_MS) {
        return fs.readFileSync(filePath, "utf8");
      } else {
        fs.unlinkSync(filePath);
      }
    } catch (err) { console.error("Cache file check failed:", err); }
  }

  try {
    const { data } = await supabaseService
      .from("vin_queries")
      .select("report_data, created_at")
      .eq("vin", v)
      .eq("type", t)                               // FIX-4: filter by type
      .not("report_data", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.report_data) {
      const age = Date.now() - new Date(data.created_at).getTime();
      if (age < MAX_AGE_MS) {
        writeCache(v, t, data.report_data);
        return data.report_data;
      }
    }
  } catch (err) { console.error("DB cache fetch failed:", err); }

  return null;
}

function decodeReportBase64(rawB64) {
  const buf = Buffer.from(rawB64, "base64");
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return { kind: "html", html: gunzipSync(buf).toString("utf8") }; }
    catch { return { kind: "unknown", buffer: buf, error: "gunzip-failed" }; }
  }
  if (buf.slice(0, 5).toString() === "%PDF-") return { kind: "pdf", buffer: buf };
  const asText = buf.toString("utf8");
  if (/<!DOCTYPE html|<html|div class=|body>/i.test(asText.slice(0, 2048)))
    return { kind: "html", html: asText };
  return { kind: "unknown", buffer: buf };
}

/* ================================================================
   FIX 1: Consumed Sessions — DB-backed
================================================================ */
async function isSessionConsumed(sessionId) {
  try {
    const { data } = await supabaseService
      .from("consumed_sessions")
      .select("session_id")
      .eq("session_id", sessionId)
      .maybeSingle();
    return !!data;
  } catch { return false; }
}

// FIX-2: Insert relies on the unique constraint on session_id.
// If a duplicate-key error comes back we throw SESSION_ALREADY_CONSUMED so
// the caller can distinguish a race from any other DB failure.
// This collapses the read-then-write race: both concurrent requests hit the
// DB insert simultaneously; exactly one succeeds and the other gets the error.
async function markSessionConsumed(sessionId) {
  const { error } = await supabaseService
    .from("consumed_sessions")
    .insert({ session_id: sessionId });

  if (error) {
    // Postgres unique-violation code is 23505; Supabase surfaces it in error.code
    if (error.code === "23505" || /unique|duplicate/i.test(error.message)) {
      throw new Error("SESSION_ALREADY_CONSUMED");
    }
    throw new Error(`Failed to mark session consumed: ${error.message}`);
  }
}

async function unmarkSessionConsumed(sessionId) {
  await supabaseService
    .from("consumed_sessions")
    .delete()
    .eq("session_id", sessionId);
}

/* ================================================================
   FIX 2: Share Tokens — DB-backed
================================================================ */
async function createShareToken(vin, type) {
  const token     = Buffer.from(crypto.randomUUID()).toString("base64url").replace(/=/g, "");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await supabaseService.from("share_tokens").insert({
    token,
    vin:        vin.toUpperCase(),
    type:       type.toLowerCase(),
    expires_at: expiresAt,
  });
  return { token, expiresAt };
}

async function getShareToken(token) {
  const { data } = await supabaseService
    .from("share_tokens")
    .select("vin, type, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data;
}

/* ================================================================
   FIX 5: Atomic Credit Updates
================================================================ */
async function addCreditsAtomic(userId, delta) {
  const { error } = await supabaseService.rpc("add_credits", {
    p_user:  userId,
    p_delta: delta,
  });
  if (error) throw new Error(`Credit update failed: ${error.message}`);
}

/* ================================================================
   FIX 6: Pending Charges — DB-backed crash-safe refunds
================================================================ */
async function createPendingCharge({ userId = null, sessionId = null, vin }) {
  const { data, error } = await supabaseService
    .from("pending_charges")
    .insert({ user_id: userId, session_id: sessionId, vin })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to record charge: ${error.message}`);
  return data.id;
}

async function resolvePendingCharge(chargeId) {
  await supabaseService.from("pending_charges").delete().eq("id", chargeId);
}

async function refundAndResolve(chargeId, userId, sessionId) {
  try {
    if (userId) {
      await addCreditsAtomic(userId, 1);
      console.log(`[Refund] Refunded 1 credit to user ${userId} for charge ${chargeId}`);
    } else if (sessionId) {
      if (sessionId.startsWith("pp_")) {
        const captureId = sessionId.replace("pp_", "");
        try {
          const refundReq = new paypalSdk.payments.CapturesRefundRequest(captureId);
          refundReq.requestBody({
            reason: "AutoVINReveal: VIN not found or report generation failed.",
          });
          await ppClient.execute(refundReq);
          console.log(`[Refund] Successfully issued real PayPal refund for capture ${captureId}`);
        } catch (ppErr) {
          console.error(`[Refund] FATAL: PayPal API refund failed for ${captureId}:`, ppErr.message);
        }
      } else if (sessionId.startsWith("cs_")) {
        try {
          const sStripe = stripeForId(sessionId);
          const session = await sStripe.checkout.sessions.retrieve(sessionId);
          if (session.payment_intent) {
            await sStripe.refunds.create({
              payment_intent: session.payment_intent,
              reason: "requested_by_customer",
            });
            console.log(`[Refund] Successfully issued real Stripe refund for session ${sessionId}`);
          }
        } catch (stripeErr) {
          console.error(`[Refund] FATAL: Stripe API refund failed for ${sessionId}:`, stripeErr.message);
        }
      }
      await unmarkSessionConsumed(sessionId);
    }
  } catch (e) {
    console.error(`[Refund] Failed to resolve charge ${chargeId}:`, e.message);
  }
  await supabaseService.from("pending_charges").delete().eq("id", chargeId);
}

const STALE_CHARGE_THRESHOLD_MS = 15 * 60 * 1000;

async function reconcileStalePendingCharges() {
  try {
    const threshold = new Date(Date.now() - STALE_CHARGE_THRESHOLD_MS).toISOString();
    const { data } = await supabaseService
      .from("pending_charges")
      .select("*")
      .lt("created_at", threshold);

    if (!data?.length) return;
    console.log(`[Reconcile] Found ${data.length} stale charge(s) — refunding...`);

    for (const charge of data) {
      console.log(`[Reconcile] Refunding charge ${charge.id} for VIN ${charge.vin}`);
      await refundAndResolve(charge.id, charge.user_id, charge.session_id);
    }
  } catch (e) {
    console.error("[Reconcile] Startup reconciliation failed:", e.message);
  }
}

/* ================================================================
   VIN Validation
================================================================ */
const VIN_WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
const VIN_MAP = Object.freeze({
  A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,
  S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,
  0:0,1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,
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
  return vin[8] === (r === 10 ? "X" : String(r));
}
function validateVin(vinRaw) {
  const vin = (vinRaw || "").toUpperCase().trim();
  if (!isPlausibleVinFormat(vin))
    return { ok: false, code: "format",      msg: "VIN must be 17 characters (no I, O, Q)." };
  if (!vinCheckDigitOk(vin))
    return { ok: false, code: "check_digit", msg: "VIN check digit is invalid." };
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
      catch { return res.status(400).send("Webhook verification failed"); }
    } else { return res.status(400).send("Webhook verification failed"); }
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session   = event.data.object;
      const sStripe   = stripeForId(session.id);
      const lineItems = await sStripe.checkout.sessions.listLineItems(session.id, { limit: 10 });

      let creditsToAdd = 0;
      for (const li of lineItems.data) {
        const pid = li.price?.id;
        const qty = li.quantity || 1;
        if      (pid === PRICE_10PACK) creditsToAdd += qty * CREDITS_PER_10PACK;
        else if (pid === PRICE_5PACK)  creditsToAdd += qty * CREDITS_PER_5PACK;
        else if (pid === PRICE_SINGLE) creditsToAdd += qty * CREDITS_PER_SINGLE;
      }

      const userId = session.metadata?.user_id || session.client_reference_id || null;

      if (!userId && creditsToAdd > 0) {
        console.warn(
          `[Webhook] Guest purchase — no userId. Credits (${creditsToAdd}) not stored. Session: ${session.id}`
        );
      }

      if (userId && creditsToAdd > 0) {
        await addCreditsAtomic(userId, creditsToAdd);
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Webhook handler error:", e);
    return res.status(500).send("Webhook handler error");
  }
});

/* ================================================================
   Middleware
================================================================ */
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: false }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// FIX-5: Applied to both create-order and capture-order. Previously only
// capture-order was rate-limited, leaving create-order as an unmetered
// vector for burning through PayPal API credentials.
const paypalCaptureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many PayPal requests",
});

/* ================================================================
   PayPal client
================================================================ */
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

// FIX-5 & ordering: reconcileStalePendingCharges runs after ppClient is defined
// so that any PayPal refunds issued during reconciliation have a live client.
reconcileStalePendingCharges();

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

    const isTenPack  = price_id === "STRIPE_PRICE_10PACK" || price_id === "10pack";
    const isFivePack = price_id === "STRIPE_PRICE_5PACK"  || price_id === "5pack";

    let priceLive = PRICE_SINGLE;
    let intent    = vin ? "buy_report" : "buy_credit_single";
    if (isTenPack)       { priceLive = PRICE_10PACK; intent = "buy_credits_10pack"; }
    else if (isFivePack) { priceLive = PRICE_5PACK;  intent = "buy_credits_5pack"; }

    const session = await stripeLive.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: priceLive, quantity: 1 }],
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&intent=${encodeURIComponent(intent)}${vin ? `&vin=${encodeURIComponent(vin)}` : ""}`,
      cancel_url:  `${SITE_URL}/?checkout=cancel`,
      ...(userId ? { client_reference_id: userId } : {}),
      metadata: {
        ...(userId      ? { user_id: userId }    : {}),
        ...(vin         ? { vin }                 : {}),
        ...(report_type ? { report_type }         : {}),
        intent,
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Stripe error" });
  }
});

// Credits endpoint — requires auth, user can only read their own balance
app.get("/api/credits/:user_id", async (req, res) => {
  try {
    const { user } = await getUser(req);
    if (!user)                          return res.status(401).json({ error: "unauthorized" });
    if (user.id !== req.params.user_id) return res.status(403).json({ error: "forbidden" });

    const { data, error } = await supabaseService
      .from("credits")
      .select("balance")
      .eq("user_id", req.params.user_id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ balance: data?.balance ?? 0 });
  } catch { res.status(500).json({ error: "Server error" }); }
});

/* ================================================================
   PayPal — Create Order
   FIX-5: paypalCaptureLimiter now applied here as well.
================================================================ */
app.post("/api/paypal/create-order", paypalCaptureLimiter, async (req, res) => {
  try {
    const { package: pkgKey, vin, state, plate, user_id } = req.body;

    let customIdentifier = "";
    let description      = "";

    if (vin) {
      const v = validateVin(vin);
      if (!v.ok) return res.status(422).json({ error: "invalid_vin", reason: v.code, message: v.msg });
      customIdentifier = v.vin;
      description      = `Vehicle History Report (VIN: ${customIdentifier})`;
    } else if (state && plate) {
      const safeState  = state.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const safePlate  = plate.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      customIdentifier = `PLATE:${safePlate}:${safeState}`;
      description      = `Vehicle History Report (Plate: ${safePlate}, ${safeState})`;
    } else {
      if (!user_id && pkgKey === "single") {
        return res.status(400).json({ error: "missing_vehicle", message: "A VIN or License Plate is required." });
      }
      customIdentifier = user_id ? `USER:${user_id}` : "GUEST_BUNDLE";
      description      = "AutoVINReveal Credits";
    }

    const pkg = resolvePaypalPackage(pkgKey);

    const invoiceId = [
      pkgKey || "single",
      customIdentifier.replace(/[^A-Za-z0-9]/g, "-").slice(0, 60),
      Date.now(),
    ].join("_");

    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [{
        amount: {
          currency_code: "USD",
          value:         pkg.amount,
          breakdown: {
            item_total: { currency_code: "USD", value: pkg.amount },
          },
        },
        custom_id:  customIdentifier,
        invoice_id: invoiceId,
        description,
        items: [{
          name:        description,
          unit_amount: { currency_code: "USD", value: pkg.amount },
          quantity:    "1",
          description: user_id ? `User: ${user_id}` : "Guest purchase",
          sku:         pkgKey || "single",
        }],
      }],
    });

    const order = await ppClient.execute(request);
    res.json({ id: order.result.id });
  } catch (err) {
    console.error("PayPal Create Error:", err);
    res.status(500).json({ error: "Failed to create PayPal order" });
  }
});

/* ================================================================
   PayPal — Capture Order
================================================================ */
app.post("/api/paypal/capture-order", paypalCaptureLimiter, async (req, res) => {
  try {
    const { orderID, user_id, package: pkg = "single" } = req.body || {};
    if (!orderID) return res.status(400).json({ error: "orderID required" });

    const { credits } = resolvePaypalPackage(pkg);

    if (pkg !== "single" && !user_id) {
      return res.status(400).json({ error: "user_id required for bundle purchases" });
    }

    const capReq = new paypalSdk.orders.OrdersCaptureRequest(orderID);
    capReq.requestBody({});
    const capRes    = await ppClient.execute(capReq);
    const cap       = capRes?.result?.purchase_units?.[0]?.payments?.captures?.[0];
    const captureId = cap?.id || null;

    if (!captureId || cap?.status !== "COMPLETED")
      return res.status(400).json({ error: "Capture not completed" });

    const verified = await verifyPaypalCapture(captureId);
    if (!verified || verified.status !== "COMPLETED")
      return res.status(400).json({ error: "Capture verification failed" });

    if (user_id) await addCreditsAtomic(user_id, credits);

    console.log(`[PayPal] Captured ${pkg} (${credits} credit${credits > 1 ? "s" : ""}) for user ${user_id || "guest"}`);

    res.json({ ok: true, captureId, credits });
  } catch (err) {
    console.error("PayPal capture error:", err);
    res.status(500).json({ error: "PayPal capture failed" });
  }
});

/* ================================================================
   Main Report Logic
================================================================ */
app.post("/api/report", async (req, res) => {
  let targetVin       = "";
  let type            = "carfax";
  let currentUser     = null;
  let oneTimeSession  = null;
  let alreadyOwned    = false;
  let pendingChargeId = null;

  try {
    const {
      vin, state, plate,
      type:           reqType,
      as:             as           = "html",
      allowLive:      allowLiveRaw,
      oneTimeSession: reqSession,
    } = req.body || {};

    type           = (reqType || "carfax").toLowerCase();
    const allowLive = allowLiveRaw !== false;
    oneTimeSession  = reqSession;

    // 1. Resolve VIN
    targetVin = (vin || "").trim().toUpperCase();
    if (!targetVin && state && plate) {
      const safeState = state.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const safePlate = plate.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      try {
        const txt = await csGet(`${CS}/checkplate/${safeState}/${safePlate}`);
        const m   = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
        if (m) targetVin = m[0];
      } catch { return res.status(400).json({ error: "plate_lookup_failed" }); }
    }
    if (!targetVin) return res.status(400).json({ error: "vin_required" });

    // 2. Validate VIN
    const v = validateVin(targetVin);
    if (!v.ok) return res.status(422).json({ error: "invalid_vin", reason: v.code, message: v.msg });
    targetVin = v.vin;

    // 3. Check cache
    let raw = await getReportData(targetVin, type);

    // 4. Check ownership
    if (!oneTimeSession) {
      const { user } = await getUser(req);
      currentUser = user;
      if (currentUser) {
        const { data: past } = await supabaseService
          .from("vin_queries")
          .select("id")
          .eq("user_id", currentUser.id)
          .eq("vin", targetVin)
          .eq("type", type)                        // FIX-4: match on type too
          .eq("success", true)
          .maybeSingle();
        if (past) alreadyOwned = true;
      }
    }

    // 5. Live fetch
    if (!raw && allowLive) {

      if (!alreadyOwned && !oneTimeSession) {
        if (currentUser) {
          // FIX-3: Create the pending charge row FIRST so a crash between this
          // point and the RPC call is recoverable via reconcileStalePendingCharges.
          // If use_credit_for_vin returns an error (e.g. insufficient credits)
          // the pending row is deleted immediately before returning 402.
          pendingChargeId = await createPendingCharge({
            userId: currentUser.id,
            vin:    targetVin,
          });

          const { error: rpcErr } = await supabaseForToken(
            req.headers.authorization?.split(" ")[1]
          ).rpc("use_credit_for_vin", { p_vin: targetVin, p_result_url: null });

          if (rpcErr) {
            await resolvePendingCharge(pendingChargeId);
            pendingChargeId = null;
            return res.status(402).json({ error: "insufficient_credits" });
          }
        } else {
          return res.status(401).json({ error: "purchase_required" });
        }
      }

      if (oneTimeSession && !alreadyOwned) {
        try {
          if (!oneTimeSession.startsWith("pp_")) {
            const sStripe = stripeForId(oneTimeSession);
            const s       = await sStripe.checkout.sessions.retrieve(oneTimeSession);
            if (s.payment_status !== "paid") throw new Error("unpaid");
          }

          // FIX-2: markSessionConsumed now throws SESSION_ALREADY_CONSUMED if the
          // unique constraint fires, preventing a concurrent request from consuming
          // the same session token. No pre-check needed — the insert IS the check.
          await markSessionConsumed(oneTimeSession);
          pendingChargeId = await createPendingCharge({
            sessionId: oneTimeSession,
            vin:       targetVin,
          });
        } catch (e) {
          if (e.message === "SESSION_ALREADY_CONSUMED") {
            return res.status(400).json({ error: "receipt_already_used" });
          }
          return res.status(400).json({ error: "receipt_invalid" });
        }
      }

      try {
        const live = await csGet(`${CS}/getrecord/${type}/${targetVin}`);
        if (!live || live.length < 50)      throw new Error("CS_EMPTY_RESPONSE");
        const checkDecode = decodeReportBase64(live);
        if (checkDecode.kind === "unknown") throw new Error("CS_INVALID_FORMAT");

        raw = live;
        writeCache(targetVin, type, raw);

        if (currentUser) {
          // FIX-4: store type in the upsert and use (user_id, vin, type) as the
          // conflict target so CARFAX and AutoCheck results are stored separately.
          await supabaseService.from("vin_queries").upsert({
            user_id:     currentUser.id,
            vin:         targetVin,
            type:        type,
            report_data: raw,
            success:     true,
          }, { onConflict: "user_id,vin,type" });
        }

        if (pendingChargeId) await resolvePendingCharge(pendingChargeId);

      } catch (e) {
        console.error(
          `[Fetch Failed] User: ${currentUser?.id || "guest"} | VIN: ${targetVin} | Err: ${e.message}`
        );

        if (pendingChargeId) {
          await refundAndResolve(pendingChargeId, currentUser?.id || null, oneTimeSession);
          pendingChargeId = null;
        }

        const msg = String(e.message || "");
        if (msg.includes("CS_404") || /invalid.*vin|vin.*not.*found/i.test(msg)) {
          return res.status(422).json({
            error: "invalid_vin", reason: "remote_reject",
            message: "VIN not found in database. You have been refunded.",
          });
        }
        return res.status(502).json({
          error: "provider_error",
          message: "Report generation failed. You have been refunded.",
        });
      }
    }

    if (!raw) return res.status(404).json({ error: "not_found", message: "No report found." });

    // 6. Deliver
    const decoded = decodeReportBase64(raw);

    if (as === "pdf") {
      try {
        if (decoded.kind === "pdf") {
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `attachment; filename="${targetVin}-${type}.pdf"`);
          return res.send(decoded.buffer);
        }
        if (decoded.kind === "html") {
          const form = new FormData();
          form.append("base64_content", Buffer.from(decoded.html, "utf8").toString("base64"));
          form.append("vin",         targetVin);
          form.append("report_type", type);
          const pdf = await axios.post(`${CS}/pdf`, form, {
            headers: { ...H, ...form.getHeaders() },
            responseType: "arraybuffer",
            timeout: 60000,
          });
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `attachment; filename="${targetVin}-${type}.pdf"`);
          return res.send(Buffer.from(pdf.data));
        }
      } catch (pdfErr) {
        console.error("PDF generation failed, falling back to HTML:", pdfErr.message);
      }
    }

    if (decoded.kind === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(decoded.html);
    }

    if (pendingChargeId) {
      console.error(`[Delivery Failed] User: ${currentUser?.id || "guest"} | Bad format. Refunding.`);
      await refundAndResolve(pendingChargeId, currentUser?.id || null, oneTimeSession);
      pendingChargeId = null;
      return res.status(422).json({
        error: "provider_error",
        message: "Report format error. You have been refunded.",
      });
    }

    return res.status(500).json({ error: "unsupported_content" });

  } catch (err) {
    if (pendingChargeId) {
      try {
        await refundAndResolve(pendingChargeId, currentUser?.id || null, oneTimeSession);
      } catch (refundErr) {
        console.error("[Critical] Outer-catch refund failed:", refundErr.message);
      }
    }
    console.error("Critical server error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ================================================================
   Email
================================================================ */
app.post("/api/email-report", async (req, res) => {
  try {
    if (!mailer) return res.status(500).json({ error: "email_not_configured" });
    const { to, vin, state, plate, type = "carfax" } = req.body || {};
    if (!to || !String(to).includes("@")) return res.status(400).json({ error: "invalid_to" });

    let targetVin = (vin || "").trim().toUpperCase();
    if (!targetVin && state && plate) {
      const safeState = state.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const safePlate = plate.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const txt = await csGet(`${CS}/checkplate/${safeState}/${safePlate}`);
      const m   = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m) targetVin = m[0];
    }
    if (!targetVin) return res.status(400).json({ error: "vin_required" });

    const raw = await getReportData(targetVin, type);
    if (!raw) return res.status(404).json({ error: "not_cached" });

    const decoded     = decodeReportBase64(raw);
    const subject     = `${type.toUpperCase()} report for ${targetVin}`;
    const attachments = [];
    if (decoded.kind === "pdf")  attachments.push({ filename: `${targetVin}.pdf`,  content: decoded.buffer });
    if (decoded.kind === "html") attachments.push({ filename: `${targetVin}.html`, content: decoded.html });

    await mailer.sendMail({
      from: SMTP_FROM, to, subject,
      text: `Attached is your report for VIN ${targetVin}.`,
      attachments,
    });
    return res.json({ ok: true });
  } catch { return res.status(500).json({ error: "email_failed" }); }
});

/* ================================================================
   Share Tokens — DB-backed endpoints
================================================================ */
app.post("/api/share", async (req, res) => {
  try {
    const { vin, type = "carfax" } = req.body || {};
    if (!vin) return res.status(400).json({ error: "vin required" });
    const raw = await getReportData(vin, type);
    if (!raw) return res.status(404).json({ error: "not_cached" });
    const { token, expiresAt } = await createShareToken(vin, type);
    res.json({ url: `${SITE_URL}/view/${token}`, expiresAt });
  } catch { res.status(500).json({ error: "Failed to create share link" }); }
});

app.get("/view/:token", async (req, res) => {
  try {
    const meta = await getShareToken(req.params.token);
    if (!meta) return res.status(404).send("Link expired or not found");
    const raw = await getReportData(meta.vin, meta.type);
    if (!raw)  return res.status(404).send("Report not found");
    const decoded = decodeReportBase64(raw);
    if (decoded.kind === "html") { res.setHeader("Content-Type", "text/html");       return res.send(decoded.html); }
    if (decoded.kind === "pdf")  { res.setHeader("Content-Type", "application/pdf"); return res.send(decoded.buffer); }
    res.status(500).send("Unsupported format");
  } catch { res.status(500).send("Server error"); }
});

/* ================================================================
   Admin Routes
================================================================ */
function makeAdminToken() {
  const exp     = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
  const payload = JSON.stringify({ exp });
  const sig     = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  return Buffer.from(payload).toString("base64url") + "." + sig;
}

function verifyAdminToken(token) {
  if (!token) return false;
  const [p64, sig] = token.split(".");
  if (!p64 || !sig) return false;
  const payload = Buffer.from(p64, "base64url").toString("utf8");
  const expect  = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  if (expect !== sig) return false;
  try {
    const obj = JSON.parse(payload);
    if (!obj?.exp || obj.exp < Date.now()) return false;
  } catch { return false; }
  return true;
}

function requireAdmin(req, res, next) {
  if (verifyAdminToken(req.cookies?.admin_session || "")) return next();
  return res.status(401).json({ error: "unauthorized" });
}

app.post("/api/admin/login", (req, res) => {
  const provided = req.body?.password || "";
  const expected = ADMIN_PASSWORD;

  // FIX-1: timingSafeEqual is the only comparison used. The previous code also
  // performed `&& provided === expected` which is a plain string comparison that
  // leaks timing information and defeats the constant-time guarantee entirely.
  const a = Buffer.alloc(64); const b = Buffer.alloc(64);
  Buffer.from(provided).copy(a); Buffer.from(expected).copy(b);
  const match = crypto.timingSafeEqual(a, b);

  if (!match) return res.status(401).json({ error: "bad_password" });
  res.cookie("admin_session", makeAdminToken(), {
    httpOnly: true, secure: true, sameSite: "strict",
    maxAge: ADMIN_SESSION_TTL_SECONDS * 1000, path: "/",
  });
  res.json({ ok: true });
});

app.get("/api/admin/history", requireAdmin, async (_req, res) => {
  try {
    const { data } = await supabaseService
      .from("vin_queries")
      .select("id, user_id, vin, success, result_url, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    res.json({ ok: true, rows: data || [] });
  } catch { res.status(500).json({ ok: false }); }
});

app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

/* ================================================================
   Static Files & Boot
================================================================ */
app.use(express.static(path.join(__dirname, "public")));
app.get("/301", (_req, res) => res.redirect(301, "/"));
app.get("*", (req, res) => {
  if (req.accepts("html")) res.sendFile(path.join(__dirname, "public", "index.html"));
  else res.status(404).send("Not found");
});

app.listen(Number(PORT), HOST, () => {
  console.log(`\n🚀 Server is running!`);
  console.log(`-------------------------------------------`);
  console.log(`➡️  Local:   http://localhost:${PORT}`);
  console.log(`➡️  Network: http://127.0.0.1:${PORT}`);
  console.log(`-------------------------------------------\n`);
});