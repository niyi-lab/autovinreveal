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
 *   #F  — paypalClient renamed to ppClient everywhere
 *   #G  — create-order destructures `package` not `package_type`
 *   #H  — plate/state sanitised to alphanumeric before upstream URL
 *   #I  — reconcileStalePendingCharges threshold raised to 15 min
 *   #J  — PayPal order tracking: invoice_id, custom_id, items, sku
 *   #K  — amount.breakdown.item_total added to PayPal order body
 *   #L  — invoice_id middle segment capped at 60 chars
 *   #M  — FIX-1: timingSafeEqual no longer short-circuited
 *   #N  — FIX-2: markSessionConsumed atomic via unique constraint
 *   #O  — FIX-3: createPendingCharge called before use_credit_for_vin
 *   #P  — FIX-4: getReportData filters by report type in DB
 *   #Q  — FIX-5: paypalCaptureLimiter on create-order too
 *
 * PREVIOUS FIXES:
 *   BLANK-PAGE — injectReportChrome() strips Adobe DTM analytics
 *                scripts before HTML delivery. DTM reads
 *                document.currentScript.src at init time; when served
 *                from a different origin this resolves to "undefined",
 *                causing DTM to immediately navigate window.location to
 *                "undefined" + "svg/social/Favicon.svg" — blanking the
 *                report in the srcdoc iframe. Applied to both the main
 *                report route and the shared link viewer.
 *
 *   EMAIL-PDF  — /api/email-report now generates a real PDF via the
 *                CheapCARFAX API. Falls back to a link email if
 *                button) and attaches it. Falls back to a styled link
 *                email if PDF generation fails.
 *
 * FIXES IN THIS VERSION:
 *   B64-DOUBLE — Reports.VIN returns the report ALREADY base64-encoded.
 *                fetchFromReportsVin() was wrapping that string in
 *                Buffer.from(html).toString("base64") a SECOND time, so
 *                decodeReportBase64() (which only decodes once) handed a
 *                still-base64 string to the iframe — rendering a wall of
 *                random letters/numbers instead of the report.
 *                New coerceReportToBase64() detects raw-HTML vs base64 and
 *                always returns base64-of-the-real-content, so the single
 *                decode yields usable HTML/PDF. Applied to both the live
 *                fetch and the archive-hit path.
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
import cookieParser from "cookie-parser";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

/* ================================================================
   Config (env)
================================================================ */
const SITE_URL       = process.env.SITE_URL      || `http://localhost:${PORT}`;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || SITE_URL;
const FORCE_WWW      = process.env.FORCE_WWW === "1";

const APP_SECRET     = process.env.APP_SECRET    || "change_me_in_env_file";
// Fail closed: no default password. If ADMIN_PASSWORD is unset, admin login is
// disabled entirely (a "changeme" default silently opened the cross-site panel).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
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

// True client IP behind Cloudflare (orange-cloud) + Render. cf-connecting-ip is set
// by Cloudflare to the real client and can't be forged; the LEFTMOST X-Forwarded-For
// entry CAN be (an attacker prepends a fake and Cloudflare appends the real one), so
// never key rate limits / blocklists off XFF alone.
function clientIp(req) {
  return (req.headers["cf-connecting-ip"]
    || (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.ip || "").toString();
}
const WEBHOOK_PATHS = new Set(["/api/stripe-webhook", "/api/stripe-webhook/", "/api/crypto/ipn"]);

function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host || "");
}

app.use((req, res, next) => {
  if (WEBHOOK_PATHS.has(req.path)) return next();
  // Never force HTTPS/www on localhost — there's no local TLS, so it'd break dev.
  if (isLocalHost(req.headers.host)) return next();
  if (process.env.NODE_ENV === "production") {
    const xfProto = req.get("x-forwarded-proto");
    if (!req.secure && xfProto !== "https") {
      return res.redirect(308, `https://${req.headers.host}${req.url}`);
    }
  }
  // Don't force www on the raw Render hostname — www.*.onrender.com doesn't
  // exist, and cheapestcarfax.com's provider-proxy calls use it to bypass
  // Cloudflare (whose WAF blocks server UAs like axios).
  if (FORCE_WWW && req.headers.host && !req.headers.host.startsWith("www.")
      && !/\.onrender\.com(:\d+)?$/i.test(req.headers.host)) {
    return res.redirect(308, `https://www.${req.headers.host}${req.url}`);
  }
  next();
});

app.use((req, res, next) => {
  // upgrade-insecure-requests forces sub-resources to https — correct in prod,
  // but it breaks http://localhost (CSS/JS would be fetched over a non-existent
  // local TLS). Skip it for localhost.
  if (!isLocalHost(req.headers.host)) {
    res.setHeader("Content-Security-Policy", "upgrade-insecure-requests");
  }
  next();
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ── Honeypot endpoints — real users never hit these ───────────────────────
// Anyone hitting /api/bulk, /api/batch, /api/vin-list etc is a scraper
["/api/bulk", "/api/batch", "/api/vin-list", "/api/reports", "/api/export", "/api/download-all"].forEach(path => {
  app.all(path, (req, res) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
    console.warn(`[Honeypot] Hit by ${ip} — ${req.method} ${path} UA: ${(req.headers["user-agent"] || "").slice(0,80)}`);
    // Permanently block this IP
    const entry = suspiciousIps.get(ip) || { count: 0, vins: new Set(), firstSeen: Date.now() };
    entry.blocked = true;
    entry.count += 100; // poison the count
    suspiciousIps.set(ip, entry);
    // Return a fake 200 to confuse the scraper
    return res.status(200).json({ success: true, data: [] });
  });
});

/* ================================================================
   Stripe
================================================================ */
const stripeLive = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const STRIPE_TEST_SECRET_KEY = process.env.STRIPE_TEST_SECRET_KEY || null;

// In non-production environments, use test keys if available
const IS_PROD = process.env.NODE_ENV === "production";
const stripeDefault = (!IS_PROD && STRIPE_TEST_SECRET_KEY)
  ? new Stripe(STRIPE_TEST_SECRET_KEY, { apiVersion: "2024-06-20" })
  : stripeLive;

// Use test price IDs in dev if provided, otherwise fall back to live IDs
const PRICE_SINGLE = (!IS_PROD && process.env.STRIPE_TEST_PRICE_SINGLE) ? process.env.STRIPE_TEST_PRICE_SINGLE : process.env.STRIPE_PRICE_SINGLE;
const PRICE_5PACK  = (!IS_PROD && process.env.STRIPE_TEST_PRICE_5PACK)  ? process.env.STRIPE_TEST_PRICE_5PACK  : process.env.STRIPE_PRICE_5PACK;
const PRICE_20PACK = (!IS_PROD && process.env.STRIPE_TEST_PRICE_20PACK) ? process.env.STRIPE_TEST_PRICE_20PACK : process.env.STRIPE_PRICE_20PACK;

// Subscription price IDs
const SUB_STARTER  = process.env.STRIPE_PRICE_SUB_STARTER;  // $30/mo  20 reports
const SUB_PRO      = process.env.STRIPE_PRICE_SUB_PRO;      // $98/mo 100 reports
const SUB_PREMIUM  = process.env.STRIPE_PRICE_SUB_PREMIUM;  // $160/mo 200 reports

const SUB_CREDITS = {
  [SUB_STARTER]:  Number(process.env.SUB_CREDITS_STARTER  || 20),
  [SUB_PRO]:      Number(process.env.SUB_CREDITS_PRO      || 100),
  [SUB_PREMIUM]:  Number(process.env.SUB_CREDITS_PREMIUM  || 200),
};

const CREDITS_PER_SINGLE = Number(process.env.CREDITS_PER_SINGLE || "1");
const CREDITS_PER_5PACK  = Number(process.env.CREDITS_PER_5PACK  || "5");
const CREDITS_PER_20PACK = Number(process.env.CREDITS_PER_20PACK || "20");

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
    .then(() => console.log("✅ SMTP mailer ready"))
    .catch(e  => console.error("❌ SMTP failed:", e));
} else {
  console.warn("⚠️  SMTP not configured. Emails will fail.");
}

/* ================================================================
   CarfaxCheaper removed — CheapCARFAX is the sole provider
================================================================ */
const CFC_OWNER_EMAIL = process.env.CFC_OWNER_EMAIL || "";
const SITE_ID = "avr"; // distinguishes this site's chats in the shared DB

/* Owner alert for failed paid deliveries — fire-and-forget email to the owner.
   Throttled per key (30 min) so a provider outage doesn't flood the inbox; the
   one-time "stuck purchase" alerts bypass throttling naturally via unique keys. */
const ownerAlertLast = new Map();
function notifyOwner(key, subject, text) {
  try {
    const to = CFC_OWNER_EMAIL || SMTP_USER;
    if (!mailer || !to) return;
    const now = Date.now(), last = ownerAlertLast.get(key) || 0;
    if (now - last < 30 * 60 * 1000) return;
    if (ownerAlertLast.size > 500) ownerAlertLast.clear();
    ownerAlertLast.set(key, now);
    mailer.sendMail({ from: SMTP_FROM, to, subject, text })
      .then(() => console.log(`[ownerAlert] sent: ${subject}`))
      .catch((e) => console.warn("[ownerAlert] send failed:", e.message));
  } catch (_) {}
}
const CFC_CREDITS_KEY = "cfc_credits_remaining";


/* ================================================================
   Reports.VIN — sole provider
   Base: https://api.reports.vin/v1
   Auth: API-KEY header
   Endpoints used:
     GET /v1/getrecord/carfax/:vin  — fetch report HTML
     GET /v1/balance                — credit balance
================================================================ */

// Report provider — switchable via REPORT_PROVIDER ("reportsvin" | "cheapcarfax").
const REPORT_PROVIDER  = (process.env.REPORT_PROVIDER || "reportsvin").toLowerCase();
const CCF_BASE         = process.env.REPORTSVIN_BASE    || "https://api.reports.vin/v1";
const CHEAPCARFAX_BASE = process.env.CHEAPCARFAX_BASE   || "https://panel.cheapcarfax.net";
const CHEAPCARFAX_KEY  = process.env.CHEAPCARFAX_API_KEY || "";

// Shared secret for the CFC→AVR provider proxy (see /api/provider-proxy below).
// cheapcarfax only whitelisted AVR's outbound IP, so cheapestcarfax.com routes its
// provider calls through this server. Default secret = sha256 of the Supabase
// service-role key both sites already share, so no new env var is needed.
const PROVIDER_PROXY_SECRET = process.env.PROVIDER_PROXY_SECRET
  || (process.env.SERVICE_ROLE_KEY
        ? crypto.createHash("sha256").update(process.env.SERVICE_ROLE_KEY).digest("hex")
        : "");

const providerState = {
  cfc: { failures: 0, lastFailure: null },
};
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown after 3 failures

function providerHasKey() {
  return REPORT_PROVIDER === "cheapcarfax" ? !!CHEAPCARFAX_KEY : !!process.env.REPORTSVIN_API_KEY;
}

function cfcAvailable() {
  if (!providerHasKey()) return false;
  const s = providerState.cfc;
  if (s.failures >= 3 && s.lastFailure && (Date.now() - s.lastFailure) < COOLDOWN_MS) {
    console.log(`[Provider] ${REPORT_PROVIDER} in cooldown after ${s.failures} failures`);
    return false;
  }
  return true;
}

/* ----------------------------------------------------------------
   coerceReportToBase64() — B64-DOUBLE FIX

   The internal report format (cache + DB) is base64-of-the-real-bytes.
   decodeReportBase64() decodes EXACTLY ONCE, then sniffs gzip / PDF /
   HTML. So whatever we return here must be base64 of the actual
   HTML/PDF/gzip — NOT base64 of a base64 string.

   Reports.VIN returns the report ALREADY base64-encoded. The old code
   did Buffer.from(content).toString("base64") on that string, encoding
   it a second time. The single decode downstream then produced the
   still-base64 string, which the iframe rendered as a wall of random
   letters and numbers.

   This helper figures out what we actually received:
     • raw HTML / markup  → encode once
     • already base64     → keep as-is (after a decode sanity-check)
     • anything else      → encode once (safe fallback)
---------------------------------------------------------------- */
function coerceReportToBase64(content) {
  if (Buffer.isBuffer(content)) {
    return content.toString("base64");
  }
  if (typeof content !== "string") {
    return Buffer.from(String(content), "utf8").toString("base64");
  }

  const trimmed = content.trim();
  const head    = trimmed.slice(0, 4000);

  // 1. Looks like raw HTML / markup → it's the real content, encode once.
  if (/<\s*(!doctype|html|head|body|div|span|table|script|meta|section|main|article|p\b|h[1-6]\b|svg)/i.test(head)) {
    return Buffer.from(content, "utf8").toString("base64");
  }

  // 2. Pure base64 charset (no angle brackets, only A–Z a–z 0–9 + / =).
  //    Reports.VIN already base64-encoded it — store as-is, but verify it
  //    decodes to something usable so we don't pass through garbage.
  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    try {
      const buf     = Buffer.from(compact, "base64");
      const isGzip  = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
      const isPdf   = buf.slice(0, 5).toString("utf8") === "%PDF-";
      const decoded = buf.slice(0, 3000).toString("utf8");
      const isHtml  = /<\s*(!doctype|html|head|body|div|script|meta)/i.test(decoded);
      if (isGzip || isPdf || isHtml) {
        console.log(`[Reports.VIN] Detected pre-encoded base64 (${isGzip ? "gzip" : isPdf ? "pdf" : "html"}) — not re-encoding`);
        return compact;
      }
    } catch (_) { /* fall through */ }
  }

  // 3. Fallback — treat whatever we got as raw content and encode once.
  return Buffer.from(content, "utf8").toString("base64");
}

/* Title-case an ALL-CAPS "YEAR MAKE MODEL" string for display, keeping the year,
   digit-bearing tokens (X3, F-150), and short acronyms (BMW, GMC, RX) uppercase. */
function prettyVehicle(s) {
  if (!s || typeof s !== "string") return null;
  const out = s.trim().split(/\s+/).map((w) => {
    if (/^\d{4}$/.test(w)) return w;                       // year
    if (/\d/.test(w)) return w.toUpperCase();              // X3, F-150, RX350
    const bare = w.replace(/[^a-z]/gi, "");                // ignore hyphens for the check
    if (bare.length <= 3 && !/[aeiou]/i.test(bare)) return w.toUpperCase(); // BMW, GMC, CR-V, GT-R
    return w[0].toUpperCase() + w.slice(1).toLowerCase();
  }).join(" ");
  return out || null;
}

/* CheapCARFAX provider — GET /api/carfax/vin/{vin}/html, x-api-key header,
   returns JSON { html, id, yearMakeModel }. Returns { raw(base64), vehicle }. */
async function fetchFromCheapcarfax(vin, _type = "carfax") {
  if (!CHEAPCARFAX_KEY) throw new Error("RV_AUTH_ERROR:CHEAPCARFAX_API_KEY not set");
  const endpoint = `${CHEAPCARFAX_BASE}/api/carfax/vin/${vin}/html`;
  const MAX_ATTEMPTS = 3;
  let lastTransient = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[CheapCARFAX] Live fetch (attempt ${attempt}/${MAX_ATTEMPTS}): GET ${endpoint}`);
    const r = await axios.get(endpoint, {
      headers: { "x-api-key": CHEAPCARFAX_KEY },
      timeout: 45000,
      validateStatus: () => true,
    });
    console.log(`[CheapCARFAX] Status: ${r.status} for ${vin}`);
    if (r.status !== 200) console.log(`[CheapCARFAX] Body:`, JSON.stringify(r.data).slice(0, 300));

    if (r.status === 401) throw new Error("RV_AUTH_ERROR:Invalid CheapCARFAX API key");
    if (r.status === 429) throw new Error("RV_RATELIMIT:Rate limit exceeded");
    if (r.status === 400 || r.status === 404) {
      const msg = (r.data?.message || r.data?.error || JSON.stringify(r.data) || "").toString();
      if (/daily limit/i.test(msg))     throw new Error("RV_DAILY_LIMIT:" + msg);
      if (/insufficient|credit|balance/i.test(msg)) throw new Error("RV_LIMIT:" + msg);
      if (/required|17 characters|invalid|not found|no record/i.test(msg)) throw new Error("CS_404:" + msg);
      if (/not available|unavailable|try again|processing|generating|pending|temporar/i.test(msg)) {
        lastTransient = msg;
        if (attempt < MAX_ATTEMPTS) { await new Promise((s) => setTimeout(s, 2500 * attempt)); continue; }
        throw new Error("RV_UNAVAILABLE:" + msg);
      }
      throw new Error("RV_400:" + msg);
    }
    if (r.status >= 400) throw new Error(`RV_${r.status}:${JSON.stringify(r.data).slice(0, 200)}`);

    const html    = r.data?.html;
    const vehicle = prettyVehicle((r.data?.yearMakeModel || "").trim());
    if (!html || typeof html !== "string" || html.length < 100) {
      lastTransient = "empty html payload";
      if (attempt < MAX_ATTEMPTS) { await new Promise((s) => setTimeout(s, 2500 * attempt)); continue; }
      throw new Error("RV_EMPTY_RESPONSE");
    }
    console.log(`[CheapCARFAX] ✓ payload for ${vin} (${html.length} chars) — ${vehicle || "no ymm"}`);
    return { raw: coerceReportToBase64(html), vehicle };
  }
  throw new Error("RV_UNAVAILABLE:" + (lastTransient || "Report Not Available"));
}

// Main report fetch entry point — type: "carfax" | "autocheck"
// Returns { raw: <base64>, vehicle: <"YEAR Make Model"|null> }.
async function cfcGetReport(vin, type = "carfax") {
  try {
    let result;
    if (REPORT_PROVIDER === "cheapcarfax") {
      result = await fetchFromCheapcarfax(vin, type);   // { raw, vehicle }
    } else {
      const raw = await fetchFromReportsVin(vin, type);  // base64 string
      result = { raw, vehicle: null };
    }
    providerState.cfc.failures = 0;
    console.log(`[Provider] ✓ ${REPORT_PROVIDER} ${type} — VIN: ${vin}`);
    return result;
  } catch (err) {
    providerState.cfc.failures++;
    providerState.cfc.lastFailure = Date.now();
    console.error(`[Provider] ${REPORT_PROVIDER} failed for ${vin}: ${err.message}`);
    throw err;
  }
}

// ── Fetch from api.reports.vin ───────────────────────────────────────────────
async function fetchFromReportsVin(vin, type = "carfax") {
  const key = process.env.REPORTSVIN_API_KEY;
  if (!key) throw new Error("RV_ERROR:REPORTSVIN_API_KEY not set");

  // 1. Check archive first — if report already cached on their end, use it (saves a credit)
  try {
    const archiveR = await axios.get(`${CCF_BASE}/archive/${vin}`, {
      headers: { "API-KEY": key },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (archiveR.status === 200 && archiveR.data && archiveR.data?.status !== "error" && archiveR.data?.status !== "failed") {
      let html = null;
      if (typeof archiveR.data === "string" && archiveR.data.length > 100) {
        html = archiveR.data;
      } else if (archiveR.data?.html)    { html = archiveR.data.html; }
      else if (archiveR.data?.report)    { html = archiveR.data.report; }
      else if (archiveR.data?.content)   { html = archiveR.data.content; }
      if (html) {
        console.log(`[Reports.VIN] ✓ Archive hit for ${vin} — no credit consumed`);
        // B64-DOUBLE FIX: coerce instead of blindly re-encoding
        return coerceReportToBase64(html);
      }
    }
    console.log(`[Reports.VIN] Archive status ${archiveR.status} for ${vin} — raw: ${JSON.stringify(archiveR.data).slice(0, 200)}`);
  } catch (archiveErr) {
    console.log(`[Reports.VIN] Archive miss for ${vin}: ${archiveErr.message}`);
  }

  // 2. Live fetch — consumes a credit. "Report Not Available!" from this API is
  // usually transient (the upstream report is still being generated), so retry a
  // few times with a short backoff before giving up.
  const endpoint = `${CCF_BASE}/getrecord/carfax/${vin}`;
  const MAX_ATTEMPTS = 3;
  let lastTransient = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`[Reports.VIN] Live fetch (attempt ${attempt}/${MAX_ATTEMPTS}): GET ${endpoint}`);

  const r = await axios.get(endpoint, {
    headers: { "API-KEY": key },
    timeout: 45000,
    validateStatus: () => true,
  });

  console.log(`[Reports.VIN] Status: ${r.status} for ${vin}`);
  // Always log response body on non-200 so we can debug
  if (r.status !== 200) {
    console.log(`[Reports.VIN] Response body:`, JSON.stringify(r.data).slice(0, 500));
  }

  if (r.status === 401) throw new Error("RV_AUTH_ERROR:Invalid API key");
  if (r.status === 402) throw new Error("RV_LIMIT:Insufficient credits");
  if (r.status === 429) throw new Error("RV_RATELIMIT:Rate limit exceeded");
  if (r.status === 404) throw new Error("CS_404:VIN not found");
  if (r.status === 400) {
    const msg = (r.data?.message || r.data?.error || JSON.stringify(r.data) || "").toString();
    if (/daily limit/i.test(msg))     throw new Error("RV_DAILY_LIMIT:" + msg);
    if (/insufficient/i.test(msg))    throw new Error("RV_LIMIT:" + msg);
    if (/not found/i.test(msg))       throw new Error("CS_404:VIN not found");
    throw new Error("RV_400:" + msg);
  }
  if (r.status >= 400) throw new Error(`RV_${r.status}:${JSON.stringify(r.data).slice(0, 200)}`);

  // Reports.VIN returns 200 with {"status":"error","message":"..."} on auth/other errors
  if (r.data?.status === "error" || r.data?.status === "failed") {
    const msg = r.data?.message || r.data?.error || "Unknown error";
    console.error(`[Reports.VIN] API error in 200 response: ${msg}`);
    if (/invalid.*api|api.*key|api.*secret|unauthorized/i.test(msg)) {
      throw new Error("RV_AUTH_ERROR:Invalid API key — check REPORTSVIN_API_KEY in Render env");
    }
    if (/credit|balance|insufficient/i.test(msg)) throw new Error("RV_LIMIT:" + msg);
    if (/not found|no record|does\s*n[o']?t\s+exist|invalid\s+vin/i.test(msg)) throw new Error("CS_404:VIN not found");
    // Transient: report still generating / momentarily unavailable → wait & retry.
    if (/not available|unavailable|try again|processing|generating|in progress|pending|temporar/i.test(msg)) {
      lastTransient = msg;
      if (attempt < MAX_ATTEMPTS) { await new Promise((s) => setTimeout(s, 2500 * attempt)); continue; }
      throw new Error("RV_UNAVAILABLE:" + msg);
    }
    throw new Error("RV_API_ERROR:" + msg);
  }

  // Response may be a raw HTML string, a base64 string, or JSON with a field.
  let html = null;
  if (typeof r.data === "string" && r.data.length > 100) {
    // Accept any non-empty string — could be raw HTML OR base64.
    // coerceReportToBase64() figures out which.
    html = r.data;
  } else if (r.data?.html)      { html = r.data.html; }
  else if (r.data?.report)      { html = r.data.report; }
  else if (r.data?.content)     { html = r.data.content; }
  else if (r.data?.data?.html)  { html = r.data.data.html; }
  else if (r.data?.file)        { html = r.data.file; }
  else if (r.data?.carfax)      { html = r.data.carfax; }
  else if (r.data?.result)      { html = r.data.result; }
  else if (r.data?.body)        { html = r.data.body; }
  else if (r.data?.page)        { html = r.data.page; }
  else if (r.data?.base64)      { html = r.data.base64; }
  else if (r.data?.data?.base64){ html = r.data.data.base64; }

  if (!html) {
    console.error(`[Reports.VIN] 200 but no report payload — type: ${typeof r.data}`);
    console.error(`[Reports.VIN] Keys: ${Object.keys(r.data || {}).join(", ")}`);
    console.error(`[Reports.VIN] Body: ${JSON.stringify(r.data).slice(0, 800)}`);
    throw new Error("RV_EMPTY_RESPONSE");
  }

  console.log(`[Reports.VIN] ✓ Report payload for ${vin} (${html.length} chars)`);
  // B64-DOUBLE FIX: coerce instead of blindly re-encoding
  return coerceReportToBase64(html);
  }

  // Every attempt returned a transient "unavailable" signal.
  throw new Error("RV_UNAVAILABLE:" + (lastTransient || "Report Not Available!"));
}

// ── fetchFromCfc alias — kept for any internal callers ───────────────────────
const fetchFromCfc = fetchFromReportsVin;


/* ================================================================
   Reports.VIN API Limits — fetches live credit balance
================================================================ */
async function getCfcApiLimits() {
  try {
    if (REPORT_PROVIDER === "cheapcarfax") {
      if (!CHEAPCARFAX_KEY) return null;
      // Best-effort: CheapCARFAX exposes user/limits info under panel.cheapcarfax.net.
      for (const p of ["/api/user/limits", "/api/user"]) {
        try {
          const r = await axios.get(`${CHEAPCARFAX_BASE}${p}`, { headers: { "x-api-key": CHEAPCARFAX_KEY }, timeout: 8000, validateStatus: () => true });
          if (r.status === 200 && r.data && typeof r.data === "object") {
            const d = r.data;
            return {
              credits:                   d.credits ?? d.balance ?? d.credits_remaining ?? d.remaining ?? null,
              carfax_reports_left_today: d.daily_remaining ?? d.reports_left_today ?? d.dailyRemaining ?? null,
              daily_limit:               d.daily_limit ?? d.dailyLimit ?? (process.env.CCF_DAILY_HARD_LIMIT ? Number(process.env.CCF_DAILY_HARD_LIMIT) : null),
            };
          }
        } catch (_) { /* try next path */ }
      }
      return null;
    }
    const key = process.env.REPORTSVIN_API_KEY;
    if (!key) return null;
    const r = await axios.get(`${CCF_BASE}/balance`, {
      headers: { "API-KEY": key },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (r.status !== 200 || !r.data) return null;
    return {
      credits:                   r.data.balance ?? r.data.credits ?? r.data.credits_remaining ?? null,
      carfax_reports_left_today: r.data.daily_remaining ?? r.data.carfax_reports_left_today ?? null,
      daily_limit:               r.data.daily_limit ?? (process.env.CCF_DAILY_HARD_LIMIT ? Number(process.env.CCF_DAILY_HARD_LIMIT) : null),
    };
  } catch { return null; }
}

/* ================================================================
   CFC Credit Counter
   Tracks remaining CFC API report credits in Supabase app_settings.
   Starts at 195, decrements by 1 on every live report fetch.
================================================================ */
async function getCfcCredits() {
  try {
    const { data } = await supabaseService
      .from("app_settings")
      .select("value")
      .eq("key", CFC_CREDITS_KEY)
      .maybeSingle();
    if (data?.value != null) return parseInt(data.value, 10);
    // Not set yet — initialise to 195
    await supabaseService.from("app_settings")
      .upsert({ key: CFC_CREDITS_KEY, value: "195" }, { onConflict: "key" });
    return 195;
  } catch { return null; }
}

async function decrementCfcCredits() {
  try {
    // Read-modify-write with a small race window — acceptable for a counter
    const current = await getCfcCredits();
    if (current === null) return;
    const next = Math.max(0, current - 1);
    await supabaseService.from("app_settings")
      .upsert({ key: CFC_CREDITS_KEY, value: String(next) }, { onConflict: "key" });
    console.log(`[CFC Credits] ${current} → ${next}`);
  } catch (e) {
    console.error("[CFC Credits] Failed to decrement:", e.message);
  }
}

/* ================================================================
   Cache
================================================================ */
const CACHE_DIR = path.join(__dirname, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const ck = (vin, type) => path.join(CACHE_DIR, `${vin}-${type}.b64`);
const writeCache = (vin, type, data) => fs.writeFileSync(ck(vin, type), data, "utf8");

const REPORT_TTL_DAYS = 20;
const MAX_AGE_MS      = REPORT_TTL_DAYS * 24 * 60 * 60 * 1000;

async function getReportData(vin, type) {
  const v = (vin  || "").toUpperCase();
  const t = (type || "").toLowerCase();

  // 1. File cache (ephemeral — 30 day TTL)
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

  // 2. Supabase DB — 30 day TTL. Reports older than 30 days require re-purchase.
  try {
    const { data } = await supabaseService
      .from("vin_queries")
      .select("report_data, created_at")
      .eq("vin", v)
      .eq("type", t)
      .not("report_data", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.report_data) {
      const age = Date.now() - new Date(data.created_at).getTime();
      if (age < MAX_AGE_MS) {
        try { writeCache(v, t, data.report_data); } catch (_) {}
        return data.report_data;
      }
    }
  } catch (err) { console.error("DB cache fetch failed:", err); }

  // 3. Global guest cache — guest purchases have no owner row, so they live here.
  try {
    const { data: gc } = await supabaseService
      .from("report_cache")
      .select("report_data, created_at")
      .eq("vin", v).eq("type", t)
      .maybeSingle();
    if (gc?.report_data) {
      const age = Date.now() - new Date(gc.created_at).getTime();
      if (age < MAX_AGE_MS) {
        try { writeCache(v, t, gc.report_data); } catch (_) {}
        return gc.report_data;
      }
    }
  } catch (err) { console.error("report_cache fetch failed:", err.message); }

  return null;
}

// Global dedup cache, written on a GUEST purchase (guests have no vin_queries row).
// Lets the next buyer of the same VIN reuse it instead of re-paying the provider.
async function writeGlobalCache(vin, type, raw, vehicle = null) {
  try {
    await supabaseService.from("report_cache").upsert({
      vin:         (vin  || "").toUpperCase(),
      type:        (type || "carfax").toLowerCase(),
      report_data: raw,
      vehicle:     vehicle || null,
      created_at:  new Date().toISOString(),
    }, { onConflict: "vin,type" });
  } catch (err) { console.error("writeGlobalCache failed:", err.message); }
}

function decodeReportBase64(rawB64) {
  const buf = Buffer.from(rawB64, "base64");
  // Gzip compressed HTML
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return { kind: "html", html: gunzipSync(buf).toString("utf8") }; }
    catch { return { kind: "unknown", buffer: buf, error: "gunzip-failed" }; }
  }
  // PDF
  if (buf.slice(0, 5).toString() === "%PDF-") return { kind: "pdf", buffer: buf };
  // Treat everything else as HTML — different providers use different starting tags
  // (some start with <!DOCTYPE, some with <html, some with a script or comment)
  const asText = buf.toString("utf8");
  if (asText.length > 100) return { kind: "html", html: asText };
  return { kind: "unknown", buffer: buf };
}

/* ================================================================
   Report HTML Injection Helper — BLANK-PAGE FIX

   The CARFAX report HTML embeds Adobe DTM analytics scripts from
   assets.adobedtm.com. DTM reads document.currentScript.src at init
   time to compute its asset base path. When the HTML is served from
   a different origin (your server), currentScript.src resolves to
   your domain, so DTM computes base = "undefined" and immediately
   executes synchronously in <head>:
       window.location.href = "undefined" + "svg/social/Favicon.svg"

   In app.js the report renders in a sandboxed srcdoc iframe. This
   navigation blanks the iframe. Any JS patch injected into the same
   document runs AFTER DTM has already fired, so patching
   Location.prototype alone is not sufficient as the primary fix.

   SOLUTION:
   1. Strip Adobe DTM <script> tags entirely — they are pure
      analytics and removing them has zero effect on report content.
   2. Also strip <base href="undefined"> and meta-refresh as
      belt-and-suspenders.
   3. Inject a lightweight nav guard that blocks any remaining
      "undefined" navigations from other scripts.
   4. Inject dealer-hide CSS.
================================================================ */
// Print-fit — CARFAX reports carry a stale `sidebar-shown` layout class from
// their original desktop render; it forces the summary sidebar BESIDE the
// content at print time (~1419px total), which either clips the right side
// (page narrower than that) or, once the shell hits its max-width cap and
// centers, leaves a dead whitespace column (page wider). Verified in headless
// Chrome against a real cached report: WITHOUT the class the report is fully
// fluid and fills any width edge-to-edge. So: strip the class on beforeprint
// (fires for the Download buttons, postMessage print, in-frame Ctrl+P alike),
// restore it on afterprint, and let the static wide @page do the rest; also
// strip during ?pdf=1 Cloudflare renders (no beforeprint there), and force
// print-color-adjust so the report's colors survive "Background graphics" off.
// Injected with its OWN idempotency guard, separately from the main chrome, so
// reports cached with an older chrome (or baked by the sibling CFC site —
// shared cache) still gain it when re-served. Byte-identical with the CFC copy.
function addPrintFitScript(html) {
  if (!html || typeof html !== "string" || html.includes('id="vin-fitpage"')) return html;
  // Cross-site print messages: the shared cache means HTML baked by the sibling
  // site (listener for its brand message only) can be served here. Add a printing
  // listener ONLY for the brand messages this HTML provably does NOT handle (the
  // needle matches the baked chrome's exact listener code), so a cross-site entry
  // prints on both sites and a same-site entry never double-prints.
  const unhandled = ["ccf-print", "avr-print"].filter((m) => !html.includes(`e.data==='${m}'`));
  const fit =
    `<script id="vin-fitpage">(function(){if(window.__vinFitPage)return;window.__vinFitPage=1;var d=document,st=[];` +
    `function strip(){try{var els=d.querySelectorAll('.sidebar-shown');for(var i=0;i<els.length;i++){els[i].classList.remove('sidebar-shown');if(st.indexOf(els[i])<0)st.push(els[i])}}catch(e){}}` +
    `function restore(){try{for(var i=0;i<st.length;i++)st[i].classList.add('sidebar-shown');st=[]}catch(e){}}` +
    `try{var s=d.createElement('style');s.id='vin-pagesize';` +
    `s.textContent='@page{size:1240px 1750px;margin:12px}@media print{*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}}';` +
    `(d.documentElement||d.body).appendChild(s)}catch(e){}` +
    `window.addEventListener('beforeprint',strip);window.addEventListener('afterprint',restore);` +
    (unhandled.length
      ? `var pm=${JSON.stringify(unhandled)};window.addEventListener('message',function(e){if(e&&pm.indexOf(e.data)>=0){try{window.focus()}catch(_){}try{window.print()}catch(_){}}});`
      : ``) +
    `if(/[?&]pdf=1/.test(location.search)){var n=0,t=setInterval(function(){strip();if(++n>7)clearInterval(t)},700);` +
    `if(d.readyState==='complete')strip();else window.addEventListener('load',strip)}})()</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, fit + "</body>");
  return html + fit;
}

function injectReportChrome(html) {
  if (!html || typeof html !== "string") return html;

  // Already chromed — by this site (avr-report-fix) OR the sibling site (CFC bakes
  // ccf-report-fix / data-ccf-chrome into HTML we may read from the SHARED
  // report_cache/vin_queries tables). Skip so we don't double-apply the strips,
  // nav guard, and floating download button on a cross-site cache hit — but still
  // add the print-fit script (it has its own guard and is chrome-agnostic).
  if (/avr-report-fix|ccf-report-fix|data-ccf-chrome/.test(html)) return addPrintFitScript(html);

  let out = html;

  // 1. Strip third-party scripts that cause CORS errors or blank pages
  // Adobe DTM (navigates window to "undefined" URL — blanks the iframe)
  out = out.replace(/<script\b[^>]*adobedtm\.com[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<script\b[^>]*assets\.adobedtm[^>]*><\/script>/gi, "");
  out = out.replace(/<script\b[^>]*adobedtm[^>]*\/?>/gi, "");

  // Strip connect.carsimulcast.com AUTH/TRACKING resources — but KEEP anything under
  // /report_assets/. CheapCARFAX serves the React renderer (vhr2.js) and its CSS
  // (vhr.css) from connect.carsimulcast.com/report_assets/, and the report body is
  // rendered ENTIRELY by that bundle from __INITIAL__DATA__. Stripping it = empty
  // <body> = blank report. (The old provider used static.carsimulcast.com, so a
  // blanket connect-strip happened to be safe there — it isn't for CheapCARFAX.)
  const keepReportAsset = (m) => (/report_assets/i.test(m) ? m : "");
  out = out.replace(/<script\b[^>]*connect\.carsimulcast\.com[^>]*>[\s\S]*?<\/script>/gi, keepReportAsset);
  out = out.replace(/<script\b[^>]*connect\.carsimulcast\.com[^>]*\/?>/gi, keepReportAsset);
  out = out.replace(/<link\b[^>]*connect\.carsimulcast\.com[^>]*>/gi, keepReportAsset);
  // Strip Facebook pixel (blocked by ad blockers, causes noise)
  out = out.replace(/<script\b[^>]*connect\.facebook\.net[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<script\b[^>]*fbevents[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<noscript>[\s\S]*?facebook[\s\S]*?<\/noscript>/gi, "");

  // 2. Strip <base href="undefined">
  out = out.replace(/<base\b[^>]*href=["']?undefined["']?[^>]*>/gi, "");

  // 3. Strip meta refresh
  out = out.replace(/<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*>/gi, "");

  // 3b. Disable Trusted Types enforcement — CARFAX React uses innerHTML/eval
  // which Chrome blocks under Trusted Types policy, leaving body empty.
  // We inject a meta CSP that opts out of Trusted Types for this document.
  out = out.replace(/<meta\b[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, "");
  const trustedTypesBypass = `<meta http-equiv="Content-Security-Policy" content="trusted-types *; require-trusted-types-for 'script'" data-avr="bypass">`;
  // Actually we want to REMOVE any Trusted Types enforcement, not add it.
  // Just strip any existing CSP meta that enforces trusted-types.
  out = out.replace(/<meta\b[^>]*trusted-types[^>]*>/gi, "");

  // 4. Nav guard — block ALL navigations from within the iframe.
  // CARFAX scripts attempt to redirect to carfax.com or blank pages after DTM strips.
  // We block every navigation vector: href setter, assign, replace, and beforeunload.
  const guardLines = [
    "<script>",
    "(function(){",
    "  function blockNav(v){",
    "    if(typeof v!=='string') return false;",
    "    if(v.indexOf('undefined')!==-1) return true;",
    "    if(v.indexOf('http://')===0) return true;",
    "    if(v.indexOf('https://')===0) return true;",
    "    if(v==='about:blank') return true;",
    "    return false;",
    "  }",
    "  try{",
    "    var _lp=Object.getOwnPropertyDescriptor(Location.prototype,'href');",
    "    if(_lp&&_lp.set){",
    "      Object.defineProperty(Location.prototype,'href',{",
    "        set:function(v){if(blockNav(v))return;_lp.set.call(this,v);},",
    "        get:function(){return _lp.get.call(this);},",
    "        configurable:true",
    "      });",
    "    }",
    "  }catch(e){}",
    "  ['assign','replace'].forEach(function(m){",
    "    var orig=window.location[m];",
    "    try{window.location[m]=function(v){if(blockNav(v))return;orig.call(window.location,v);};}catch(e){}",
    "  });",
    "})();",
    "<\/script>",
  ];
  const guard = guardLines.join("\n");

  if (/<head[\s>]/i.test(out)) {
    out = out.replace(/(<head(?:\s[^>]*)?>)/i, "$1" + guard);
  } else {
    out = guard + out;
  }

  // 5. Dealer-hide CSS + fix blank desktop rendering
  const css = [
    "<style>",
    "  /* Hide dealer branding */",
    "  .dealer-info,.dealer-header,.co-brand-header,#dealer-wrapper,",
    "  .cpo-header,.cobrand-header,.dealer-contact-info,",
    "  div[class*='dealer'],div[id*='dealer'],div[class*='cobrand'],",
    "  .switch-wrapper,.language-toggle-wrapper{display:none!important;}",
    "  /* Force report content visible on all screen sizes.",
    "     CARFAX hides the right-side panel on wide viewports via media queries.",
    "     We force all panels visible regardless of width. */",
    "  #detail-content,#report-content,.report-content,",
    "  .main-content,.content-main,#main-content,",
    "  .right-col,.right-panel,.content-right,",
    "  [class*='content-right'],[class*='right-content'],",
    "  [class*='main-col'],[class*='report-body'],",
    "  .cfx-content,.cfx-main,#cfx-content{display:block!important;visibility:visible!important;}",
    "  /* Force full width layout so nothing hides off-screen */",
    "  body{max-width:none!important;overflow-x:auto!important;}",
    "  /* Undo any JS-driven hide that sets display:none inline on content wrappers */",
    "  .tab-content,.tabcontent,.panel,.panel-body{display:block!important;}",
    "</style>",
    "</head>",
  ].join("\n");
  out = out.replace("</head>", css);

  // 6. Patch JS that hides content based on window width
  // CARFAX sometimes runs: if(window.innerWidth > X) { element.style.display='none' }
  // We override innerWidth to always return a mobile-like value inside the srcdoc context
  const widthPatch = [
    "<script>",
    "try{",
    "  Object.defineProperty(window,'innerWidth',{get:function(){return 800;},configurable:true});",
    "  Object.defineProperty(window,'outerWidth',{get:function(){return 800;},configurable:true});",
    "  Object.defineProperty(screen,'width',{get:function(){return 800;},configurable:true});",
    "}catch(e){}",
    "<\/script>",
  ].join("");

  if (/<head[\s>]/i.test(out)) {
    out = out.replace(/(<head(?:\s[^>]*)?>)/i, "$1" + widthPatch);
  } else {
    out = widthPatch + out;
  }

  // ── Overlay neutraliser ──────────────────────────────────────────────
  // CARFAX/CheapCARFAX reports ship UI chrome (a full-screen .modal-root, a
  // .mask-over-primary-content dimmer, a fixed promo banner, coachmarks) that
  // their own JS normally hides. We strip that JS, so without this override the
  // layers stay up and cover the report — i.e. a blank screen. Force them off.
  const overlayFix = `<style id="avr-report-fix">` +
    `.modal-root,.mask-over-primary-content,.overlay,.coachmark,.coachmark_indicator,.tooltip,.cip-menu,#app-promotion-banner{display:none!important}` +
    `#app-promotion-banner-and-report-header{position:static!important}` +
    `html,body{display:block!important;visibility:visible!important;opacity:1!important;overflow:auto!important}` +
    `</style>`;
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, overlayFix + "</head>");
  else if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, overlayFix + "</body>");
  else out += overlayFix;

  // ── Download / Save-as-PDF button (every report view, incl. guests) ──────
  // Guests have no dashboard, so give the report page its own download. Uses the
  // browser's print engine (Save as PDF) — it paginates long reports correctly,
  // so nothing gets clipped (unlike client-side html2canvas capture).
  const dlBar = `<div id="avr-dlbar"><button type="button" onclick="window.print()" aria-label="Download PDF">` +
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>` +
    `Download PDF</button></div>` +
    `<style>#avr-dlbar{position:fixed;top:14px;right:14px;z-index:2147483647}` +
    `#avr-dlbar button{display:flex;align-items:center;gap:7px;background:#2563eb;color:#fff;border:none;border-radius:10px;padding:11px 18px;font:600 14px system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(37,99,235,.4)}` +
    `#avr-dlbar button:hover{background:#1d4ed8}` +
    // Wide print page so the full-width report fits without clipping on the right
    // (matches the Cloudflare email-PDF render width). The print engine paginates
    // vertically, so only the page WIDTH matters for clipping.
    `@page{size:1240px 1750px;margin:12px}` +
    `@media print{#avr-dlbar{display:none!important}}</style>` +
    // 1) Remove this floating button when (a) Cloudflare renders the PDF (?pdf=1),
    //    or (b) the report is inside the in-app overlay iframe — the overlay toolbar
    //    already has a Download PDF button, so the floating one would be a duplicate.
    //    It stays on the standalone /view share page, which has no toolbar.
    // 2) Listen for the overlay's "avr-print" postMessage and print THIS document
    //    (the rendered report) in place — prints just the report, no blank tab.
    `<script>try{if(/[?&]pdf=1/.test(location.search)||window.self!==window.top){var _b=document.getElementById('avr-dlbar');if(_b)_b.remove()}}catch(e){}` +
    `try{window.addEventListener('message',function(e){if(e&&e.data==='avr-print'){try{window.focus()}catch(_){}try{window.print()}catch(_){}}});}catch(e){}</script>`;
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, dlBar + "</body>");
  else out += dlBar;

  return addPrintFitScript(out);
}

/* ================================================================
   Consumed Sessions — DB-backed (FIX-2 atomic)
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

async function markSessionConsumed(sessionId) {
  const { error } = await supabaseService
    .from("consumed_sessions")
    .insert({ session_id: sessionId });
  if (error) {
    if (error.code === "23505" || /unique|duplicate/i.test(error.message)) {
      throw new Error("SESSION_ALREADY_CONSUMED");
    }
    throw new Error(`Failed to mark session consumed: ${error.message}`);
  }
}

async function unmarkSessionConsumed(sessionId) {
  await supabaseService.from("consumed_sessions").delete().eq("session_id", sessionId);
}

/* ================================================================
   Share Tokens — DB-backed
================================================================ */
async function createShareToken(vin, type, vehicle = null) {
  const token     = Buffer.from(crypto.randomUUID()).toString("base64url").replace(/=/g, "");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await supabaseService.from("share_tokens").insert({
    token,
    vin:        vin.toUpperCase(),
    type:       type.toLowerCase(),
    vehicle:    vehicle || null,
    expires_at: expiresAt,
  });
  return { token, expiresAt };
}

async function getShareToken(token) {
  const { data } = await supabaseService
    .from("share_tokens")
    .select("vin, type, vehicle, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data;
}

/* Derive a "YEAR MAKE MODEL" label from a provider report, for share previews.
   The report body is React-rendered from embedded JSON, so we read that JSON
   (or a visible "YYYY Make Model" string) rather than the rendered DOM. */
function extractVehicleLabel(html) {
  if (!html || typeof html !== "string") return null;
  // 1. Structured JSON fields embedded by the provider (e.g. __INITIAL__DATA__).
  const year  = html.match(/"(?:modelYear|model_year|year)"\s*:\s*"?(\d{4})"?/i)?.[1];
  const make  = html.match(/"make(?:Name)?"\s*:\s*"([^"]{2,30})"/i)?.[1];
  const model = html.match(/"model(?:Name)?"\s*:\s*"([^"]{1,40})"/i)?.[1];
  if (year && make) {
    const label = [year, make, model].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (label.length >= 6) return label;
  }
  // 2. Fallback: a visible "YYYY Make Model" string (title/heading).
  const m = html.match(/\b(?:19|20)\d{2}\s+[A-Z][A-Za-z-]{1,18}(?:\s+[A-Za-z0-9][A-Za-z0-9.-]{0,18}){0,3}/);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

/* Make names that should NOT be naively title-cased (acronyms / styling). */
const MAKE_OVERRIDES = {
  BMW: "BMW", GMC: "GMC", "MERCEDES-BENZ": "Mercedes-Benz", MINI: "MINI",
  RAM: "Ram", FIAT: "FIAT", BYD: "BYD", "ROLLS-ROYCE": "Rolls-Royce",
  KIA: "Kia", "ALFA ROMEO": "Alfa Romeo", "LAND ROVER": "Land Rover",
};
function normalizeMake(make) {
  const up = make.trim().toUpperCase();
  if (MAKE_OVERRIDES[up]) return MAKE_OVERRIDES[up];
  return make.trim().replace(/\b[a-z]+/gi, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/* Authoritative VIN → "YEAR MAKE MODEL" via NHTSA vPIC (free, no key).
   Cached in-memory by VIN; returns null on failure so callers can fall back. */
const VEHICLE_LABEL_CACHE = new Map();
async function decodeVinLabel(vin) {
  if (!vin) return null;
  const key = vin.toUpperCase();
  if (VEHICLE_LABEL_CACHE.has(key)) return VEHICLE_LABEL_CACHE.get(key);
  try {
    const r = await axios.get(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(key)}?format=json`,
      { timeout: 4000 }
    );
    const row   = r.data?.Results?.[0] || {};
    const year  = String(row.ModelYear || "").trim();
    const make  = String(row.Make || "").trim();
    const model = String(row.Model || "").trim();
    if (make) {
      const label = [year, normalizeMake(make), model].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      if (label.length >= 4) { VEHICLE_LABEL_CACHE.set(key, label); return label; }
    }
  } catch { /* network/timeout — fall through to null */ }
  return null;
}

/* Inject Open Graph / Twitter meta into a shared report's <head> so links
   preview with the vehicle's year+model instead of a blank card. */
function injectShareMeta(html, { vin, vehicle, url }) {
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const host  = SITE_URL.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const title = (vehicle ? `${vehicle} — Vehicle History Report` : `Vehicle History Report — VIN ${vin}`) + ` | ${host}`;
  const desc  = vehicle
    ? `Full history for this ${vehicle}: accidents, title brands, odometer, open recalls & service records — via AutoVINReveal.`
    : `Full vehicle history report: accidents, title brands, odometer, recalls & service records — via AutoVINReveal.`;
  const img = `${SITE_URL}/og-image.png`;
  const tags =
    `<title>${esc(title)}</title>\n` +
    `<meta name="description" content="${esc(desc)}">\n` +
    `<meta name="robots" content="noindex,nofollow">\n` +
    `<meta property="og:type" content="article">\n` +
    `<meta property="og:site_name" content="AutoVINReveal">\n` +
    `<meta property="og:title" content="${esc(title)}">\n` +
    `<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:url" content="${esc(url)}">\n` +
    `<meta property="og:image" content="${esc(img)}">\n` +
    `<meta property="og:image:width" content="1200">\n` +
    `<meta property="og:image:height" content="630">\n` +
    `<meta name="twitter:card" content="summary_large_image">\n` +
    `<meta name="twitter:title" content="${esc(title)}">\n` +
    `<meta name="twitter:description" content="${esc(desc)}">\n` +
    `<meta name="twitter:image" content="${esc(img)}">`;
  // Drop the provider's own <title> so ours is the one shown.
  let out = html.replace(/<title>[\s\S]*?<\/title>/i, "");
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head[^>]*>/i, (mt) => `${mt}\n${tags}`);
  return `<head>${tags}</head>\n${out}`;
}

/* ================================================================
   Atomic Credit Updates
================================================================ */
async function addCreditsAtomic(userId, delta) {
  const { error } = await supabaseService.rpc("add_credits", {
    p_user:  userId,
    p_delta: delta,
  });
  if (error) throw new Error(`Credit update failed: ${error.message}`);
}

// Reverse up to `amount` credits (never drives the balance below 0), logging a
// 'refund' ledger entry. Used by the refund/chargeback handlers. Returns the number
// of credits actually reversed.
async function reverseCredits(userId, amount) {
  if (!supabaseService || !userId || !amount) return 0;
  const { data, error } = await supabaseService.rpc("refund_credits", { p_user: userId, p_amount: amount });
  if (error) { console.error("[refund] reverseCredits error:", error.message); return 0; }
  return data || 0;
}

/* ================================================================
   Pending Charges — DB-backed crash-safe refunds
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

async function refundAndResolve(chargeId, userId, sessionId, reason = "") {
  try {
    if (userId) {
      await addCreditsAtomic(userId, 1);
      console.log(`[Refund] +1 credit to user ${userId} for charge ${chargeId}`);
      notifyOwner(`refund:${userId}`,
        `AutoVINReveal: report FAILED — credit auto-refunded`,
        `A report delivery failed; the customer's credit was AUTO-REFUNDED.\n\nUser: ${userId}\nCharge: ${chargeId}${reason ? `\nReason: ${reason}` : ""}\n\nIf this keeps happening check provider credits / the whitelisted outbound IP.`);
    } else if (sessionId) {
      if (sessionId.startsWith("cs_")) {
        try {
          const sStripe = stripeForId(sessionId);
          const session = await sStripe.checkout.sessions.retrieve(sessionId);
          if (session.payment_intent) {
            await sStripe.refunds.create({ payment_intent: session.payment_intent, reason: "requested_by_customer" });
            console.log(`[Refund] Stripe refund issued for session ${sessionId}`);
            notifyOwner(`refund:${sessionId}`,
              `AutoVINReveal: report FAILED — Stripe payment auto-refunded`,
              `A guest report delivery failed; their Stripe payment was AUTO-REFUNDED.\n\nSession: ${sessionId}${reason ? `\nReason: ${reason}` : ""}`);
          }
        } catch (stripeErr) {
          console.error(`[Refund] FATAL: Stripe refund failed for ${sessionId}:`, stripeErr.message);
          notifyOwner(`refundfail:${sessionId}`,
            `AutoVINReveal: URGENT — auto-refund FAILED, refund manually`,
            `A guest report delivery failed AND the automatic Stripe refund also failed.\nRefund this payment manually in the Stripe dashboard.\n\nSession: ${sessionId}\nRefund error: ${stripeErr.message}${reason ? `\nOriginal failure: ${reason}` : ""}`);
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
      await refundAndResolve(charge.id, charge.user_id, charge.session_id,
        `stale pending charge (crash recovery) for VIN ${charge.vin || "unknown"}`);
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
    // Idempotency — Stripe delivers events at least once; never double-grant credits.
    const { error: dupErr } = await supabaseService
      .from("processed_webhook_events")
      .insert({ event_id: event.id });
    if (dupErr) {
      if (dupErr.code === "23505") return res.status(200).json({ ok: true, duplicate: true });
      console.error("[Webhook] idempotency insert error:", dupErr.message);
    }

    // ── One-time purchases ──
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Subscription checkout — store customer↔user mapping then grant first month credits
      if (session.mode === "subscription") {
        const userId     = session.metadata?.user_id || session.client_reference_id || null;
        const customerId = session.customer;
        const subId      = session.subscription;

        if (userId && customerId) {
          // Store Stripe customer ID on the credits row for future renewals
          await supabaseService.from("credits")
            .update({ stripe_customer_id: customerId, stripe_subscription_id: subId })
            .eq("user_id", userId);
          console.log(`[Sub] New subscription ${subId} for user ${userId}`);
        }
        // Credits for first period are granted by invoice.paid below
        return res.status(200).json({ ok: true });
      }

      // One-time purchase
      const sStripe   = stripeForId(session.id);
      const lineItems = await sStripe.checkout.sessions.listLineItems(session.id, { limit: 10 });

      let creditsToAdd = 0;
      for (const li of lineItems.data) {
        const pid = li.price?.id;
        const qty = li.quantity || 1;
        if      (pid === PRICE_20PACK) creditsToAdd += qty * CREDITS_PER_20PACK;
        else if (pid === PRICE_5PACK)  creditsToAdd += qty * CREDITS_PER_5PACK;
        else if (pid === PRICE_SINGLE) creditsToAdd += qty * CREDITS_PER_SINGLE;
      }

      const userId = session.metadata?.user_id || session.client_reference_id || null;
      if (!userId && creditsToAdd > 0) {
        console.warn(`[Webhook] Guest purchase — no userId. Credits (${creditsToAdd}) not stored. Session: ${session.id}`);
      }
      if (userId && creditsToAdd > 0) {
        await addCreditsAtomic(userId, creditsToAdd);
      }
    }

    // ── Subscription renewal — grant credits each billing period ──
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      // Only act on subscription invoices, not one-time charges
      if (!invoice.subscription) return res.status(200).json({ ok: true });

      const customerId = invoice.customer;
      const priceId    = invoice.lines?.data?.[0]?.price?.id;
      const credits    = SUB_CREDITS[priceId] || 0;

      if (credits > 0 && customerId) {
        // Look up user by stripe_customer_id
        const { data: row } = await supabaseService
          .from("credits")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();

        if (row?.user_id) {
          await addCreditsAtomic(row.user_id, credits);
          console.log(`[Sub] Renewed ${credits} credits for user ${row.user_id} (price ${priceId})`);
        } else {
          console.warn(`[Sub] invoice.paid — no user found for customer ${customerId}`);
        }
      }
    }

    // ── Subscription cancelled ──
    if (event.type === "customer.subscription.deleted") {
      const sub        = event.data.object;
      const customerId = sub.customer;
      await supabaseService.from("credits")
        .update({ stripe_subscription_id: null })
        .eq("stripe_customer_id", customerId);
      console.log(`[Sub] Cancelled subscription for customer ${customerId}`);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Webhook handler error:", e);
    // Roll back the idempotency marker so Stripe's retry can reprocess this event.
    try { await supabaseService.from("processed_webhook_events").delete().eq("event_id", event.id); } catch (_) {}
    return res.status(500).send("Webhook handler error");
  }
});

/* ================================================================
   Whop Webhook — Standard Webhooks signature (HMAC-SHA256 over
   `${webhook-id}.${webhook-timestamp}.${rawBody}`, header `webhook-signature`
   = "v1,<base64>"). On payment.succeeded, grant credits to the Supabase
   user passed as checkout metadata.user_id. Set WHOP_WEBHOOK_SECRET (ws_...).
================================================================ */
const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET || "";
const WHOP_API_KEY = process.env.WHOP_API_KEY || "";
const WHOP_PLANS = {                        // button key -> Whop plan + credits + price
  single: { plan: "plan_DvE2Z32UAeyTl", credits: CREDITS_PER_SINGLE, price: 5.99  },
  pack5:  { plan: "plan_N1GiRFY8AGfpH", credits: CREDITS_PER_5PACK,  price: 20.00 },
  pack20: { plan: "plan_0f5gjPm3KD8YO", credits: CREDITS_PER_20PACK, price: 58.00 },
  // Monthly subscriptions (recurring, dealers). Credits are granted each billing
  // period and EXPIRE (~60 days) — stored in the shared cfc_sub_batches table and
  // spent before the permanent balance. Logged-in only (credits need an account).
  sub_starter: { plan: process.env.WHOP_PLAN_SUB_STARTER || "plan_Rpl9UnqCeaHOM", credits: 20,  price: 39,  recurring: true },
  sub_dealer:  { plan: process.env.WHOP_PLAN_SUB_DEALER  || "plan_XyBtVs2UF29Kh", credits: 50,  price: 89,  recurring: true },
  sub_pro:     { plan: process.env.WHOP_PLAN_SUB_PRO     || "plan_Y3nf6zzuYRCIF", credits: 100, price: 169, recurring: true },
};
// plan_id -> monthly credits, for granting on each subscription payment.
const WHOP_SUB_CREDITS = {
  [WHOP_PLANS.sub_starter.plan]: WHOP_PLANS.sub_starter.credits,
  [WHOP_PLANS.sub_dealer.plan]:  WHOP_PLANS.sub_dealer.credits,
  [WHOP_PLANS.sub_pro.plan]:     WHOP_PLANS.sub_pro.credits,
};
const isWhopSubPlan = (planId) => !!planId && Object.prototype.hasOwnProperty.call(WHOP_SUB_CREDITS, planId);
async function whopApi(method, path, body) {
  try {
    const r = await fetch("https://api.whop.com" + path, {
      method,
      headers: { Authorization: "Bearer " + WHOP_API_KEY, Accept: "application/json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, json: null, error: e.message }; }
}
const WHOP_PLAN_CREDITS = {                 // plan_id -> credits (fallback if no metadata.credits)
  "plan_DvE2Z32UAeyTl": CREDITS_PER_SINGLE,  // Single Report  $5.99
  "plan_N1GiRFY8AGfpH": CREDITS_PER_5PACK,   // 5 Report Pack  $20
  "plan_0f5gjPm3KD8YO": CREDITS_PER_20PACK,  // 20 Report Pack $58
};

/* ================================================================
   PayGate.to — alternative checkout (crypto/card -> USDC on Polygon).
   Reuses the ENTIRE existing fulfilment pipeline: a PayGate checkout writes a
   normal whop_checkouts row (session id "pg_..."), and the PayGate IPN callback
   marks it paid and calls fulfillWhopRow() — the same function the Whop
   reconcile job uses. No change to report fetch / claim / email.

   API shape confirmed from PayGate's Postman collection:
     1) GET wallet.php?address=<wallet>&callback=<IPN_URL>  -> { address_in, ipn_token }
        The callback URL (with OUR query params) is BOUND here; PayGate echoes all
        of our original params back on the IPN. So we wrap PER ORDER (no caching)
        and embed session_id+secret in the callback.
     2) GET process-payment.php?address=<address_in>&amount=&provider=&email=&currency=
        -> redirects buyer to the hosted pay page. (This is the URL we send them to.)
     3) IPN: PayGate GETs our callback with value_coin, coin, txid_in, address_in
        + our echoed session_id & secret.
   NOTE: one-time plans only (single/pack5/pack20). Recurring subs are NOT
   supported here — PayGate is one-shot crypto, it can't rebill monthly.
================================================================ */
const PAYGATE_WALLET       = process.env.PAYGATE_WALLET || "";
const PAYGATE_WRAP_URL     = process.env.PAYGATE_WRAP_URL     || "https://api.paygate.to/control/wallet.php";
const PAYGATE_CHECKOUT_URL = process.env.PAYGATE_CHECKOUT_URL || "https://checkout.paygate.to/process-payment.php";
const PAYGATE_CALLBACK_SECRET = process.env.PAYGATE_CALLBACK_SECRET || "";   // set a fixed value in prod

// Wrap our wallet with a per-order callback. Returns { addressIn, ipnToken }.
// addressIn comes back already percent-encoded by PayGate — pass it through verbatim.
async function paygateWrap(callbackUrl) {
  if (!PAYGATE_WALLET) throw new Error("PAYGATE_WALLET not set");
  const url = `${PAYGATE_WRAP_URL}?address=${encodeURIComponent(PAYGATE_WALLET)}`
            + `&callback=${encodeURIComponent(callbackUrl)}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  const addressIn = j.address_in || (j.data && j.data.address_in);
  if (!addressIn) throw new Error("paygate wallet-wrap failed: " + JSON.stringify(j).slice(0, 200));
  return { addressIn, ipnToken: j.ipn_token || null };
}

// Guest single report (no account): fetch the report and email a view-link to the
// buyer. Lets guests buy one report on Whop without logging in.
async function deliverGuestReportByEmail(vin, type, to) {
  if (!mailer) { console.error("[Whop] mailer not configured — cannot deliver guest report"); return; }
  const v = (vin || "").toUpperCase(), t = (type || "carfax").toLowerCase();
  let raw = await getReportData(v, t), vehicle = null;
  if (!raw) {
    const fetched = await cfcGetReport(v, t);    // consumes 1 provider credit (paid for)
    raw = fetched.raw; vehicle = fetched.vehicle;
    try { writeCache(v, t, raw); } catch (_) {}
    await writeGlobalCache(v, t, raw, vehicle);  // so /view/:token can resolve it
  }
  const { token } = await createShareToken(v, t, vehicle);
  const reportUrl = `${SITE_URL}/view/${token}`;
  await mailer.sendMail({
    from: SMTP_FROM, to,
    subject: `Your Vehicle History Report — ${v}`,
    text: `Your vehicle history report for VIN ${v} is ready.\n\nView it here: ${reportUrl}\n\nTo save as PDF, open the link and press Ctrl+P (Windows) or Cmd+P (Mac).`,
    html: `<p>Your vehicle history report for VIN <b>${v}</b> is ready.</p>`
        + `<p><a href="${reportUrl}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">View your report</a></p>`
        + `<p>Or open this link: ${reportUrl}</p><p>To save as PDF, open it and press Ctrl+P / Cmd+P.</p>`,
  });
  console.log(`[Whop] guest report for ${v} emailed to ${to}`);
}

// Professional, branded report email — cover banner + "view report" button.
// Render the live report page to a PDF via Cloudflare Browser Rendering (real
// Chrome that runs the report's JS). Returns a Buffer, or null on any failure.
async function renderReportPdf(token) {
  const acct = process.env.CF_ACCOUNT_ID, cfTok = process.env.CF_BR_TOKEN;
  if (!acct || !cfTok) return null;
  try {
    const r = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${acct}/browser-rendering/pdf`,
      { url: `${SITE_URL}/view/${token}?pdf=1`, gotoOptions: { waitUntil: "networkidle0", timeout: 30000 }, viewport: { width: 1100, height: 1500, deviceScaleFactor: 2 }, emulateMediaType: "screen", pdfOptions: { width: "1140px", height: "1760px", printBackground: true, preferCSSPageSize: true } },
      { headers: { Authorization: `Bearer ${cfTok}` }, responseType: "arraybuffer", timeout: 45000 }
    );
    const buf = Buffer.from(r.data);
    return buf.slice(0, 5).toString() === "%PDF-" ? buf : null;
  } catch (e) { console.warn("[PDF] Cloudflare render failed:", e.message); return null; }
}

async function sendReportEmail(to, vin, vehicle, token, attachPdf = false) {
  if (!mailer || !to || !token) return;
  const reportUrl = `${SITE_URL}/view/${token}`;
  const title = vehicle || "Your Vehicle History Report";
  const cover = "https://www.autovinreveal.com/og-image.png";
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.07);">
      <tr><td style="line-height:0;"><a href="${reportUrl}"><img src="${cover}" alt="AutoVINReveal" width="600" style="display:block;width:100%;height:auto;border:0;"></a></td></tr>
      <tr><td style="padding:32px 32px 8px;">
        <p style="margin:0 0 10px;color:#16a34a;font-weight:700;font-size:12px;letter-spacing:.5px;text-transform:uppercase;">&#10003; Payment confirmed</p>
        <h1 style="margin:0 0 6px;font-size:22px;line-height:1.25;color:#0f172a;">Your vehicle history report is ready</h1>
        <p style="margin:0 0 2px;font-size:18px;font-weight:600;color:#0f172a;">${title}</p>
        <p style="margin:0 0 26px;font-size:14px;color:#64748b;">VIN: ${vin}</p>
        <a href="${reportUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 30px;border-radius:8px;">View Your Full Report &rarr;</a>
        <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;">Or open this link:<br><a href="${reportUrl}" style="color:#2563eb;word-break:break-all;">${reportUrl}</a></p>
      </td></tr>
      <tr><td style="padding:0 32px;"><hr style="border:0;border-top:1px solid #eef2f7;margin:24px 0;"></td></tr>
      <tr><td style="padding:0 32px 28px;">
        <p style="margin:0;font-size:13px;color:#64748b;">&#128161; <b>Save a PDF copy:</b> open the report and press <b>Ctrl+P</b> (Windows) or <b>Cmd+P</b> (Mac), then choose &ldquo;Save as PDF&rdquo;.</p>
      </td></tr>
      <tr><td style="padding:0 32px 24px;">
        <div style="background:#eff6ff;border:1px solid #dbeafe;border-radius:10px;padding:18px 20px;">
          <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#1e3a8a;">Checking more than one car?</p>
          <p style="margin:0 0 12px;font-size:13px;color:#475569;line-height:1.5;">Save with a bundle &mdash; credits never expire:<br><b>5 reports for $20</b> ($4 each) &middot; <b>20 reports for $58</b> ($2.90 each).</p>
          <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 20px;border-radius:7px;">See bundles &amp; save &rarr;</a>
        </div>
      </td></tr>
      <tr><td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #eef2f7;">
        <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;"><b style="color:#475569;">AutoVINReveal</b> &middot; Vehicle History Reports<br>Questions? Contact <a href="mailto:support@autovinreveal.com" style="color:#2563eb;">support@autovinreveal.com</a></p>
      </td></tr>
    </table>
    <p style="margin:14px 0 0;font-size:11px;color:#cbd5e1;">You received this because you purchased a report at autovinreveal.com.</p>
  </td></tr></table></body></html>`;
  const text = `Your vehicle history report is ready.\n\n${title}\nVIN: ${vin}\n\nView your full report:\n${reportUrl}\n\nTo save as PDF, open the link and press Ctrl+P (Windows) or Cmd+P (Mac).\n\nAutoVINReveal — support@autovinreveal.com`;
  const mailOpts = { from: SMTP_FROM, to, subject: `Your Vehicle History Report — ${vehicle || vin}`, html, text };
  if (attachPdf) {
    const pdf = await renderReportPdf(token);
    if (pdf) mailOpts.attachments = [{ filename: `${String(vehicle || vin).replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}-report.pdf`, content: pdf, contentType: "application/pdf" }];
  }
  await mailer.sendMail(mailOpts);
  console.log(`[Whop] report email sent to ${to} (${vin})`);
}

// Shared fulfillment for a 'paid' row (used by the reconcile job). Atomic guard.
// Grant a subscription payment's monthly credits EXACTLY ONCE. Idempotent by the
// Whop payment id in the shared processed_webhook_events table, so the claim (instant
// first month) and the renewal poller can't double-grant. Credits EXPIRE (~60 days):
// stored in cfc_sub_batches, spent before the permanent balance (see /api/report).
async function grantWhopSubPayment(paymentId, planId, userId) {
  if (!paymentId || !userId) return 0;
  const credits = WHOP_SUB_CREDITS[planId] || 0;
  if (!credits) return 0;
  const { error } = await supabaseService
    .from("processed_webhook_events")
    .insert({ event_id: "avrsub_" + paymentId });
  if (error) {                          // 23505 = already granted for this payment
    if (error.code === "23505" || /duplicate|unique/i.test(error.message || "")) return 0;
    console.error("[Whop sub] idempotency insert error:", error.message);
    return 0;
  }
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  const { error: e2 } = await supabaseService
    .from("cfc_sub_batches")
    .insert({ user_id: userId, remaining: credits, expires_at: expiresAt });
  if (e2) {
    console.error("[Whop sub] batch insert failed:", e2.message);
    await supabaseService.from("processed_webhook_events").delete().eq("event_id", "avrsub_" + paymentId);  // allow a retry
    return 0;
  }
  console.log(`[Whop sub] +${credits} expiring credits to ${userId} (plan ${planId}, payment ${paymentId}, expires ${expiresAt})`);
  return credits;
}

// Renewals have no buyer return — poll recent Whop payments and grant each
// subscription payment's credits once (also backstops a missed first month).
async function grantWhopSubRenewals() {
  if (!WHOP_API_KEY || !supabaseService) return;
  try {
    const pr = await whopApi("GET", "/api/v2/payments?per=50");
    const payments = (pr.json && (pr.json.data || pr.json)) || [];
    if (!Array.isArray(payments)) return;
    for (const p of payments) {
      if (!(p.status === "paid" || p.paid_at)) continue;
      const planId = (p.plan && (p.plan.id || p.plan)) || p.plan_id || null;
      if (!isWhopSubPlan(planId)) continue;
      const userId = (p.metadata && (p.metadata.user_id || p.metadata.userId))
        || (p.membership && p.membership.metadata && (p.membership.metadata.user_id || p.membership.metadata.userId))
        || null;
      if (!userId) { console.warn(`[Whop sub] payment ${p.id} (plan ${planId}) has no user_id metadata — skipped`); continue; }
      await grantWhopSubPayment(p.id, planId, userId);
    }
  } catch (e) { console.warn("[Whop sub] renewal poll error:", e.message); }
}

// Non-expired subscription credits (added to displayed balances).
async function getSubCreditBalance(userId) {
  if (!supabaseService || !userId) return 0;
  const { data: subs } = await supabaseService
    .from("cfc_sub_batches")
    .select("remaining")
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString());
  return Array.isArray(subs) ? subs.reduce((s, b) => s + (b.remaining || 0), 0) : 0;
}

async function fulfillWhopRow(row) {
  const { data: claimed } = await supabaseService.from("whop_checkouts")
    .update({ status: "fulfilling" }).eq("session_id", row.session_id).eq("status", "paid").select().maybeSingle();
  if (!claimed) return;   // already being handled / fulfilled elsewhere
  try {
    // Pack purchase (no VIN) — grant credits, no provider fetch. Subscriptions are
    // credited per-payment by grantWhopSubRenewals() (idempotent), so never grant
    // them here (would double-grant the first month).
    if (!row.vin) {
      if (row.user_id && !isWhopSubPlan(row.plan_id)) await addCreditsAtomic(row.user_id, row.credits || 0);
      await supabaseService.from("whop_checkouts").update({
        status: "fulfilled", fulfilled_at: new Date().toISOString(),
      }).eq("session_id", row.session_id);
      console.log(`[Whop] reconciled -> fulfilled ${isWhopSubPlan(row.plan_id) ? "subscription" : "pack"} (user ${row.user_id || "none"}, session ${row.session_id})`);
      return;
    }
    let raw = await getReportData(row.vin, row.type), vehicle = row.vehicle || null;
    if (!raw) {
      const f = await cfcGetReport(row.vin, row.type);
      raw = f.raw; vehicle = f.vehicle;
      try { writeCache(row.vin, row.type, raw); } catch (_) {}
      await writeGlobalCache(row.vin, row.type, raw, vehicle);
    }
    const { token } = await createShareToken(row.vin, row.type, vehicle);
    if (row.user_id) {
      await supabaseService.from("vin_queries").upsert(
        { user_id: row.user_id, vin: row.vin, type: row.type, success: true, report_data: raw, vehicle },
        { onConflict: "user_id,vin,type" });
    }
    await supabaseService.from("whop_checkouts").update({
      status: "fulfilled", delivered_token: token, vehicle, fulfilled_at: new Date().toISOString(),
    }).eq("session_id", row.session_id);
    if (row.buyer_email) await sendReportEmail(row.buyer_email, row.vin, vehicle, token, !row.user_id).catch((e) => console.warn("[Whop] reconcile email failed:", e.message));
    console.log(`[Whop] reconciled -> fulfilled (vin ${row.vin}, session ${row.session_id}, email ${row.buyer_email || "none"})`);
  } catch (e) {
    await supabaseService.from("whop_checkouts").update({ status: "paid" }).eq("session_id", row.session_id);
    console.warn(`[Whop] reconcile fetch failed (${row.session_id}):`, e.message);
    if (row.vin) notifyOwner(`whop-fail:${row.vin}`,
      `AutoVINReveal: PAID Whop report fetch failed — ${row.vin}`,
      `A customer PAID via Whop but the provider fetch failed (background retry). Auto-retry continues; ` +
      `you'll get a one-time STUCK alert if it still hasn't delivered after 45 min.\n\n` +
      `VIN: ${row.vin} (${row.type})\nBuyer: ${row.buyer_email || "unknown"}\nWhop session: ${row.session_id}\nError: ${e.message}`);
  }
}

// Safety net: buyers who paid but never landed back on the claim (closed tab /
// different browser, and the webhook didn't arrive). Delivers report + email.
async function reconcileWhopCheckouts() {
  if (!WHOP_API_KEY || !supabaseService) return;
  const SITE = "avr";
  try {
    // A) Marked 'paid' (webhook/claim) but the report was never fetched.
    const paidCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: paidRows } = await supabaseService.from("whop_checkouts")
      .select("*").eq("site", SITE).eq("status", "paid").is("delivered_token", null)
      .lt("created_at", paidCutoff).limit(15);
    for (const row of (paidRows || [])) await fulfillWhopRow(row);

    // B) Still 'pending' after 10 min — reconcile against recent Whop payments by VIN.
    const pendCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const minCreated = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const { data: pendingRows } = await supabaseService.from("whop_checkouts")
      .select("*").eq("site", SITE).eq("status", "pending").is("delivered_token", null)
      .lt("created_at", pendCutoff).gt("created_at", minCreated).limit(15);
    if (pendingRows && pendingRows.length) {
      const pr = await whopApi("GET", "/api/v2/payments?per=50");
      const payments = (pr.json && (pr.json.data || pr.json)) || [];
      for (const row of pendingRows) {
        const pay = Array.isArray(payments) && payments.find((p) => {
          if (!(p.status === "paid" || p.paid_at)) return false;
          const payPlanId = ((p.plan && (p.plan.id || p.plan)) || p.plan_id);
          if (payPlanId !== row.plan_id) return false;
          if (row.vin) {
            // SINGLE — match by VIN in payment metadata.
            return ((p.metadata && p.metadata.vin) || "").toUpperCase() === String(row.vin).toUpperCase();
          }
          // PACK (no VIN) — match by Supabase user_id in payment metadata.
          const payUserId = (p.metadata && (p.metadata.user_id || p.metadata.userId)) || null;
          return !!row.user_id && payUserId === row.user_id;
        });
        if (!pay) continue;
        const email = (pay.user && pay.user.email) || pay.user_email || (await resolveWhopBuyerEmail(pay).catch(() => null));
        await supabaseService.from("whop_checkouts").update({ status: "paid", buyer_email: email })
          .eq("session_id", row.session_id).eq("status", "pending");
        row.status = "paid"; row.buyer_email = email;
        await fulfillWhopRow(row);
      }
    }

    // C) Paid singles STILL undelivered after 45 min — retries haven't produced a
    // report. Alert the owner ONCE per row (owner_alerted_at column is the guard,
    // claimed atomically) with everything needed to refund in the Whop dashboard.
    const stuckCutoff = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const { data: stuckRows } = await supabaseService.from("whop_checkouts")
      .select("*").eq("site", SITE).in("status", ["paid", "fulfilling"])
      .not("vin", "is", null).is("delivered_token", null).is("owner_alerted_at", null)
      .lt("created_at", stuckCutoff).limit(10);
    for (const row of (stuckRows || [])) {
      const { data: marked } = await supabaseService.from("whop_checkouts")
        .update({ owner_alerted_at: new Date().toISOString() })
        .eq("session_id", row.session_id).is("owner_alerted_at", null).select().maybeSingle();
      if (!marked) continue;   // another instance already alerted for this row
      notifyOwner(`whop-stuck:${row.session_id}`,
        `AutoVINReveal: PAID report STUCK 45+ min — ${row.vin} — buyer has NO report`,
        `A paid single-report purchase has gone 45+ minutes with no successful delivery.\n\n` +
        `VIN: ${row.vin} (${row.type})\nBuyer email: ${row.buyer_email || "unknown"}\n` +
        `Whop session: ${row.session_id}\nPlan: ${row.plan_id}\nPaid at: ${row.created_at}\n\n` +
        `The system keeps retrying every 5-10 min and will auto-deliver + email the buyer the moment the provider recovers.\n` +
        `If it doesn't recover soon: refund the payment in the Whop dashboard (Payments — search the buyer email), ` +
        `and consider emailing the buyer${row.buyer_email ? ` (${row.buyer_email})` : ""} an apology.`);
    }
  } catch (e) { console.warn("[Whop] reconcile error:", e.message); }
}
if (process.env.WHOP_API_KEY) {
  setInterval(reconcileWhopCheckouts, 10 * 60 * 1000);   // every 10 min
  setTimeout(reconcileWhopCheckouts, 60 * 1000);          // once shortly after boot
  setInterval(grantWhopSubRenewals, 10 * 60 * 1000);     // subscription renewals (no buyer return)
  setTimeout(grantWhopSubRenewals, 70 * 1000);
}

// Crypto reconcile — a NOWPayments IPN can be missed (network blip, deploy during
// callback), leaving a paid order stuck 'waiting' forever with no recovery. Re-query
// recent waiting orders and fulfill the paid ones / mark the dead ones, so a paying
// customer isn't silently left empty-handed.
async function reconcileCryptoPayments() {
  if (!NP_API_KEY || !supabaseService) return;
  try {
    const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const { data: rows } = await supabaseService.from("crypto_payments")
      .select("payment_id, order_id, credits, user_id, status, created_at")
      .eq("status", "waiting").gt("created_at", since).limit(50);
    for (const row of (rows || [])) {
      if (!row.payment_id) continue;
      let np;
      try {
        const r = await axios.get(`${NP_BASE}/payment/${row.payment_id}`, { headers: { "x-api-key": NP_API_KEY }, timeout: 8000, validateStatus: () => true });
        if (r.status !== 200) continue;
        np = r.data;
      } catch { continue; }
      const st = np?.payment_status;
      if (["finished", "confirmed"].includes(st)) {
        // Atomically claim (waiting -> fulfilled) so we can't race the IPN, then grant.
        const { data: claimed } = await supabaseService.from("crypto_payments")
          .update({ status: "fulfilled", fulfilled_at: new Date().toISOString() })
          .eq("order_id", row.order_id).neq("status", "fulfilled").select().maybeSingle();
        if (claimed && claimed.user_id) {
          await addCreditsAtomic(claimed.user_id, claimed.credits);
          console.log(`[NP reconcile] fulfilled ${row.payment_id} -> +${claimed.credits} credits to ${claimed.user_id}`);
        }
      } else if (["failed", "expired", "refunded"].includes(st)) {
        // Terminal failure — stop re-checking it.
        await supabaseService.from("crypto_payments").update({ status: st }).eq("order_id", row.order_id).eq("status", "waiting");
      }
      // else waiting/pending/partially_paid → leave for the next sweep
    }
  } catch (e) { console.warn("[NP reconcile] error:", e.message); }
}

// Resolve the buyer's email from a Whop payment payload (falls back to the member record).
async function resolveWhopBuyerEmail(data) {
  let email = data.user_email || data.email || (data.user && data.user.email) ||
              (data.member && data.member.email) || data.receipt_email || (data.metadata && data.metadata.email) || null;
  if (!email) {
    const uid = typeof data.user === "string" ? data.user : (data.user_id || (data.user && data.user.id) || null);
    if (uid) {
      const m = await whopApi("GET", `/api/v2/members?user_id=${encodeURIComponent(uid)}`);
      email = (m.json && m.json.data && m.json.data[0] && m.json.data[0].email) || null;
    }
  }
  return email;
}

function verifyWhopWebhook(rawBody, headers) {
  if (!WHOP_WEBHOOK_SECRET) return false;
  // Whop v2 webhooks authenticate with a shared secret in the `webhook-secret`
  // header (sent over HTTPS, like an API key) — not an HMAC signature.
  const provided = headers["webhook-secret"] || headers["x-whop-secret"] || "";
  if (!provided || provided.length !== WHOP_WEBHOOK_SECRET.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(WHOP_WEBHOOK_SECRET)); }
  catch { return false; }
}

app.post("/api/whop-webhook", express.raw({ type: "*/*" }), async (req, res) => {
  if (!verifyWhopWebhook(req.body, req.headers)) {
    console.warn(`[Whop] signature verify failed (id=${req.headers["webhook-id"]}, ts=${req.headers["webhook-timestamp"]})`);
    return res.status(400).send("Webhook verification failed");
  }
  let event;
  try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).send("bad json"); }
  const type = event.action || event.event || event.type || "";
  const data = event.data || event || {};

  try {
    const eventId = "whop_" + (data.id || req.headers["webhook-id"] || "");
    const { error: dupErr } = await supabaseService.from("processed_webhook_events").insert({ event_id: eventId });
    if (dupErr && dupErr.code === "23505") return res.status(200).json({ ok: true, duplicate: true });

    if (type === "payment.succeeded") {
      const meta       = data.metadata || (data.membership && data.membership.metadata) || {};
      // The ch_ session id lives on the membership — data.checkout_id is a different internal id.
      const checkoutId = (data.membership && data.membership.checkout_session) || data.checkout_session || meta.sid || null;
      const userId     = meta.user_id || meta.userId || null;   // Supabase id (NOT data.user.id, which is Whop's)
      const planId     = (data.plan && (data.plan.id || data.plan)) || data.plan_id || (data.membership && data.membership.plan) || null;
      // Diagnostic (confirms the real payload shape on the first live delivery):
      console.log(`[Whop:dbg] type=${type} payment=${data.id} checkout_id=${checkoutId} planId=${planId} metaKeys=${Object.keys(meta).join(",")} dataKeys=${Object.keys(data).join(",")}`);

      // Our checkout row is AUTHORITATIVE for vin/type. Map by the ch_ session id,
      // falling back to the most-recent pending row for the VIN.
      let row = null;
      if (checkoutId) {
        const { data: r } = await supabaseService.from("whop_checkouts").select("*").eq("session_id", checkoutId).eq("site", "avr").maybeSingle();
        row = r || null;
      }
      const vin     = (row?.vin  || meta.vin  || "").toUpperCase();
      const type2   = (row?.type || meta.type || "carfax").toLowerCase();
      const credits = (parseInt(meta.credits, 10) || 0) || WHOP_PLAN_CREDITS[planId] || 0;
      // Bind ONLY by the exact checkout session id above. The old "most-recent
      // pending row for this VIN" fallback was unscoped by site AND by buyer, so a
      // payment could attach to a DIFFERENT buyer's / different site's pending
      // checkout — stamping the wrong buyer_email and emailing that report to
      // someone who never bought it (the 2021 Supra → wrong inbox bug). Rows the
      // webhook can't bind here are fulfilled by the buyer's own claim (claim_token)
      // or the reconcile job (vin-matched), so nothing legitimate is lost.

      if (vin && row) {
        // SINGLE report — only MARK the row paid (entitled). The report itself is
        // fetched on /api/whop/claim, where the buyer is actively waiting. This keeps
        // the webhook fast + immune to provider latency/timeouts (the bug that left
        // rows stuck pending). pending -> paid only; never downgrade a fulfilled row.
        const buyerEmail = await resolveWhopBuyerEmail(data).catch(() => null);
        await supabaseService.from("whop_checkouts")
          .update({ status: "paid", buyer_email: buyerEmail })
          .eq("session_id", row.session_id).eq("status", "pending");
        console.log(`[Whop] payment confirmed -> row paid (vin ${vin}, session ${row.session_id}, payment ${data.id})`);
      } else if (userId && (isWhopSubPlan(planId) || credits > 0)) {
        // No-VIN purchase (pack or subscription). The buyer's /api/whop/claim can
        // ALSO fulfill this, so atomically claim the checkout row first and grant
        // only if THIS call flipped it. Previously this granted UNCONDITIONALLY:
        //   • a claim+webhook race double-granted packs, and
        //   • subscriptions were wrongly given PERMANENT credits here on top of the
        //     EXPIRING credits from grantWhopSubPayment()/the renewal poller.
        let mayGrant = true;
        if (row) {
          const { data: claimed } = await supabaseService.from("whop_checkouts")
            .update({ status: "fulfilled", fulfilled_at: new Date().toISOString() })
            .eq("session_id", row.session_id).neq("status", "fulfilled").neq("status", "fulfilling")
            .select().maybeSingle();
          mayGrant = !!claimed;
        }
        if (mayGrant) {
          if (isWhopSubPlan(planId)) {
            // Subscription → EXPIRING credits only, idempotent by payment id (shared
            // with the claim + renewal poller). Never permanent.
            await grantWhopSubPayment(data.id, planId, userId);
            console.log(`[Whop] subscription payment -> expiring credits (user ${userId}, plan ${planId}, payment ${data.id})`);
          } else {
            await addCreditsAtomic(userId, credits);
            console.log(`[Whop] +${credits} credits to ${userId} (pack, plan ${planId}, payment ${data.id})`);
          }
        } else {
          console.log(`[Whop] no-VIN already fulfilled elsewhere (session ${row?.session_id})`);
        }
      } else {
        console.warn(`[Whop] paid but unlinked — user=${userId} plan=${planId} vin=${vin} checkout=${checkoutId} meta=${JSON.stringify(meta).slice(0,140)}`);
      }
    } else if (/refund|dispute|charge.?back/i.test(type)) {
      // Refund / chargeback / dispute. Whop's exact event name varies, so match broadly.
      // Reverse a cleanly-identified one-time PACK grant (clamped so balance can't go
      // negative) and ALWAYS email the owner — subscription/guest refunds and anything
      // we can't match are left for manual handling so we never mis-reverse.
      const meta       = data.metadata || (data.membership && data.membership.metadata) || {};
      const checkoutId = (data.membership && data.membership.checkout_session) || data.checkout_session || meta.sid || null;
      const planId     = (data.plan && (data.plan.id || data.plan)) || data.plan_id || (data.membership && data.membership.plan) || null;
      let row = null;
      if (checkoutId) { const { data: r } = await supabaseService.from("whop_checkouts").select("*").eq("session_id", checkoutId).eq("site", "avr").maybeSingle(); row = r || null; }
      const uid     = meta.user_id || meta.userId || row?.user_id || null;
      const credits = row?.credits || WHOP_PLAN_CREDITS[planId] || parseInt(meta.credits, 10) || 0;
      const isSub   = isWhopSubPlan(planId || row?.plan_id);
      let reversed  = 0;
      if (uid && credits > 0 && !isSub) {
        reversed = await reverseCredits(uid, credits);
        if (row) await supabaseService.from("whop_checkouts").update({ status: "refunded" }).eq("session_id", row.session_id);
      }
      console.log(`[Whop] ${type} — reversed ${reversed} credits (user ${uid || "?"}, plan ${planId}, sub=${isSub}, payment ${data.id})`);
      if (mailer) {
        const ownerTo = CFC_OWNER_EMAIL || SMTP_USER;
        if (ownerTo) mailer.sendMail({
          from: SMTP_FROM, to: ownerTo,
          subject: `AutoVINReveal Whop ${type} — payment ${data.id}`,
          text: `A Whop "${type}" event arrived.\n\nPayment: ${data.id}\nUser: ${uid || "unknown"}\nPlan: ${planId}\nCredits auto-reversed: ${reversed}${isSub ? "\n\nNOTE: subscription — expiring sub credits were NOT auto-reversed; adjust manually if needed." : ""}\n\nVerify in the Whop dashboard; adjust manually if the reversal looks wrong.`,
        }).catch(e => console.error("[Whop refund email]", e.message));
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[Whop] handler error:", e.message);
    // Roll back idempotency so Whop's retry can re-attempt fulfillment (e.g. transient provider error).
    try { await supabaseService.from("processed_webhook_events").delete().eq("event_id", "whop_" + (data.id || req.headers["webhook-id"] || "")); } catch (_) {}
    return res.status(500).json({ error: "server error" });   // non-200 => Whop retries
  }
});

/* ================================================================
   Middleware
================================================================ */
app.use(express.json({ limit: "8mb" }));   // larger limit so chat screenshots fit
app.use(cookieParser());
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: false }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
// General API rate limit
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// ── Whop checkout: create a hosted-checkout session, store a claim row ──
// The signed webhook is the source of truth; this only sets up the session and
// hands the browser a secret claim token (never placed in any URL).
app.post("/api/whop/checkout", async (req, res) => {
  try {
    if (!WHOP_API_KEY) return res.status(500).json({ error: "whop_not_configured" });
    const { key, vin, type } = req.body || {};
    const cfg = WHOP_PLANS[key];
    if (!cfg) return res.status(400).json({ error: "invalid_plan" });
    const { user } = await getUser(req).catch(() => ({ user: null }));
    const userId = (user && user.id) || (req.body && req.body.user_id) || null;
    const vinUp  = vin ? String(vin).toUpperCase() : null;
    const typeL  = (type || "carfax").toLowerCase();
    const flow   = userId ? "user" : "guest";

    const metadata = { site: "avr" };   // tag the payment with its origin brand
    const redirect = `${SITE_URL}/?purchased=1&flow=${flow}`;   // no ids in the URL
    if (userId) {
      metadata.user_id = userId;
      metadata.credits = String(cfg.credits);
      if (vinUp) { metadata.vin = vinUp; metadata.type = typeL; }   // single intent
    } else if (key === "single" && vinUp) {
      metadata.vin = vinUp; metadata.type = typeL; metadata.guest = "1";
    } else {
      return res.status(401).json({ error: "login_required" });
    }

    const r = await whopApi("POST", "/api/v2/checkout_sessions", { plan_id: cfg.plan, metadata, redirect_url: redirect });
    const node    = (r.json && (r.json.data || r.json)) || {};
    const url     = node.purchase_url || null;
    const session = node.id || node.checkout_session || null;     // ch_...
    if (!url || !session) {
      console.error("[Whop] checkout create failed:", r.status, JSON.stringify(r.json).slice(0, 240));
      return res.status(502).json({ error: "checkout_failed" });
    }

    // Capability token — returned to the buyer's browser only.
    const claimToken = crypto.randomBytes(32).toString("hex");
    const { error: insErr } = await supabaseService.from("whop_checkouts").insert({
      session_id: session, claim_token: claimToken, vin: vinUp, type: typeL,
      user_id: userId, flow, plan_id: cfg.plan, credits: cfg.credits, expected_price: cfg.price,
      status: "pending", site: "avr",
    });
    if (insErr) { console.error("[Whop] whop_checkouts insert failed:", insErr.message); return res.status(502).json({ error: "checkout_failed" }); }

    return res.json({ url, claim: claimToken });
  } catch (e) {
    console.error("[Whop] /api/whop/checkout error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// ── PayGate checkout: same row shape as Whop, but redirect to PayGate's hosted
// pay page. Fulfilment happens in the callback below via fulfillWhopRow(). ──
app.post("/api/paygate/checkout", async (req, res) => {
  try {
    if (!PAYGATE_WALLET) return res.status(500).json({ error: "paygate_not_configured" });
    const { key, vin, type } = req.body || {};
    const cfg = WHOP_PLANS[key];
    if (!cfg) return res.status(400).json({ error: "invalid_plan" });
    if (cfg.recurring) return res.status(400).json({ error: "subscriptions_not_supported" });  // PayGate is one-shot
    const { user } = await getUser(req).catch(() => ({ user: null }));
    const userId = (user && user.id) || (req.body && req.body.user_id) || null;
    const vinUp  = vin ? String(vin).toUpperCase() : null;
    const typeL  = (type || "carfax").toLowerCase();
    const flow   = userId ? "user" : "guest";
    // Same entitlement rules as Whop: packs require login; guest may only buy a single+VIN.
    if (!userId && !(key === "single" && vinUp)) return res.status(401).json({ error: "login_required" });

    const sessionId  = "pg_" + crypto.randomUUID();
    const claimToken = crypto.randomBytes(32).toString("hex");
    const buyerEmail = (user && user.email) || (req.body && req.body.email) || null;
    const { error: insErr } = await supabaseService.from("whop_checkouts").insert({
      session_id: sessionId, claim_token: claimToken, vin: vinUp, type: typeL,
      user_id: userId, flow, plan_id: cfg.plan, credits: cfg.credits, expected_price: cfg.price,
      status: "pending", site: "avr", buyer_email: buyerEmail,
    });
    if (insErr) { console.error("[PayGate] insert failed:", insErr.message); return res.status(502).json({ error: "checkout_failed" }); }

    // The callback (with our session id + secret) is BOUND into the wallet wrap;
    // PayGate echoes these params back on the IPN. Wrap per-order (no caching).
    const callback = `${SITE_URL}/api/paygate/callback`
      + `?session_id=${encodeURIComponent(sessionId)}&secret=${encodeURIComponent(PAYGATE_CALLBACK_SECRET)}`;
    const { addressIn, ipnToken } = await paygateWrap(callback);
    if (ipnToken) await supabaseService.from("whop_checkouts").update({ pg_ipn_token: ipnToken }).eq("session_id", sessionId);

    // address_in is already percent-encoded by PayGate — do NOT re-encode it.
    // Build the process-payment URL by hand so URLSearchParams can't double-encode it.
    const q = `address=${addressIn}`
      + `&amount=${encodeURIComponent(Number(cfg.price).toFixed(2))}`
      + `&provider=moonpay`
      + `&email=${encodeURIComponent(buyerEmail || "")}`
      + `&currency=USD`;
    const url = `${PAYGATE_CHECKOUT_URL}?${q}`;
    return res.json({ url, claim: claimToken });
  } catch (e) {
    console.error("[PayGate] /api/paygate/checkout error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// PayGate server-to-server success callback. Marks the row paid, then fulfils via
// the shared pipeline (report fetch + email / credits). Idempotent + secret-gated.
app.get("/api/paygate/callback", async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || "");
    const secret    = String(req.query.secret || "");
    const want      = Buffer.from(PAYGATE_CALLBACK_SECRET);
    const got       = Buffer.from(secret);
    const secretOk  = PAYGATE_CALLBACK_SECRET && want.length === got.length && crypto.timingSafeEqual(want, got);
    if (!sessionId.startsWith("pg_") || !secretOk) return res.status(403).send("forbidden");

    const { data: row } = await supabaseService.from("whop_checkouts")
      .select("*").eq("session_id", sessionId).eq("site", "avr").maybeSingle();
    if (!row) return res.status(404).send("unknown");
    if (row.status === "fulfilled") return res.status(200).send("ok");   // idempotent

    // Amount sanity-check: PayGate sends value_coin (USDC paid). Require >= ~98% of
    // the expected price (small tolerance for provider fee/rounding). This blocks a
    // spoofed/underpaid callback from unlocking a report even if the secret leaked.
    const paidCoin = parseFloat(req.query.value_coin || "0");
    const expected = parseFloat(row.expected_price || "0");
    if (expected > 0 && paidCoin > 0 && paidCoin < expected * 0.98) {
      console.warn(`[PayGate] underpaid callback ignored: session ${sessionId} paid ${paidCoin} < expected ${expected}`);
      return res.status(200).send("ok");   // ack so PayGate stops retrying; do NOT fulfil
    }

    // pending -> paid (only if still pending), then fulfil through the shared path.
    await supabaseService.from("whop_checkouts")
      .update({ status: "paid" }).eq("session_id", sessionId).eq("status", "pending");
    const { data: fresh } = await supabaseService.from("whop_checkouts").select("*").eq("session_id", sessionId).maybeSingle();
    await fulfillWhopRow(fresh || row);
    return res.status(200).send("ok");
  } catch (e) {
    console.error("[PayGate] /api/paygate/callback error:", e.message);
    return res.status(500).send("error");   // non-200 => PayGate retries
  }
});

// Verify a Whop payment server-side (used when the webhook hasn't marked the row
// paid — webhook delivery is unreliable). Binds payment->row by VIN + plan + amount.
async function fetchWhopPayment(paymentId) {
  if (!paymentId || !/^pay_/.test(paymentId)) return null;
  const p = await whopApi("GET", `/api/v2/payments/${encodeURIComponent(paymentId)}`);
  return (p.json && (p.json.data || p.json)) || null;
}
function whopPaymentMatchesRow(pd, row) {
  if (!pd || !(pd.status === "paid" || pd.paid_at)) return false;
  const pmVin  = ((pd.metadata && pd.metadata.vin) || (pd.membership && pd.membership.metadata && pd.membership.metadata.vin) || "").toUpperCase();
  const planId = (pd.plan && (pd.plan.id || pd.plan)) || pd.plan_id || null;
  const pmSite = ((pd.metadata && pd.metadata.site) || (pd.membership && pd.membership.metadata && pd.membership.metadata.site) || "").toLowerCase();
  const amount = parseFloat(pd.final_amount || pd.total || "0");
  // A vin-specific (single-report) row may ONLY be fulfilled by a payment that
  // names that exact VIN. The old check bypassed this when the payment had no vin
  // metadata — which let a vin-less/mismatched payment fulfill a report for the
  // wrong car and email it to the wrong buyer. reconcile already requires the vin
  // (matches by p.metadata.vin), so requiring it here is consistent and safe.
  if (row.vin && pmVin !== String(row.vin).toUpperCase()) return false;
  // Never let one brand's payment fulfill the other brand's row (both sites share
  // whop_checkouts). Soft: only rejects a positive mismatch, so payments created
  // before the site tag existed still work.
  if (row.site && pmSite && pmSite !== row.site) return false;
  if (row.plan_id && planId && planId !== row.plan_id) return false;
  if (row.expected_price && amount && amount + 0.001 < Number(row.expected_price)) return false;
  return true;
}

// ── Whop claim: the redirect landing calls this. Confirms payment (the webhook's
//    'paid' flag OR direct API verification via the payment_id from the redirect),
//    then fetches the report on demand with an atomic guard so one fetch runs. ──
const whopClaimLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.post("/api/whop/claim", whopClaimLimiter, async (req, res) => {
  try {
    const claim = String(req.body?.claim || "");
    if (!/^[a-f0-9]{64}$/.test(claim)) return res.status(400).json({ error: "bad_claim" });
    const { data: row } = await supabaseService.from("whop_checkouts").select("*").eq("claim_token", claim).eq("site", "avr").maybeSingle();
    if (!row) return res.status(404).json({ error: "not_found" });
    if (row.created_at && (Date.now() - new Date(row.created_at).getTime()) > 35 * 24 * 3600 * 1000)
      return res.status(410).json({ error: "expired" });

    // Already delivered → same token back (refresh / re-open safe).
    if (row.delivered_token) return res.json({ status: "fulfilled", token: row.delivered_token, vin: row.vin || null, credits: 0 });
    // Pack (no VIN) the webhook already fulfilled → credits added.
    if (row.status === "fulfilled") return res.json({ status: "fulfilled", token: null, vin: row.vin || null, credits: row.credits || 0 });
    // Confirm payment. Fast path: the webhook already set status='paid'. Otherwise
    // verify directly via the Whop API using the payment_id from the redirect URL —
    // this makes the claim self-sufficient when the webhook never arrives.
    if (row.status === "pending") {
      const pd = await fetchWhopPayment(String(req.body?.payment_id || "")).catch(() => null);
      if (!whopPaymentMatchesRow(pd, row)) return res.status(202).json({ status: "processing" });
      const email = (pd.user && pd.user.email) || pd.user_email || row.buyer_email || (await resolveWhopBuyerEmail(pd).catch(() => null));
      await supabaseService.from("whop_checkouts").update({ status: "paid", buyer_email: email || row.buyer_email })
        .eq("session_id", row.session_id).eq("status", "pending");
      row.status = "paid"; row.buyer_email = email || row.buyer_email;
    } else if (row.status !== "paid") {
      return res.status(202).json({ status: "processing" });   // 'fulfilling' — another request is on it
    }

    // Pack purchase (no VIN) — grant spendable credits, no provider fetch.
    if (!row.vin) {
      const { data: packClaimed } = await supabaseService.from("whop_checkouts")
        .update({ status: "fulfilling" }).eq("session_id", row.session_id).eq("status", "paid").select().maybeSingle();
      if (packClaimed) {
        if (row.user_id) {
          if (isWhopSubPlan(row.plan_id)) await grantWhopSubPayment(req.body?.payment_id, row.plan_id, row.user_id);  // first month (instant, idempotent)
          else await addCreditsAtomic(row.user_id, row.credits || 0);                                                 // one-time pack
        }
        await supabaseService.from("whop_checkouts").update({
          status: "fulfilled", fulfilled_at: new Date().toISOString(),
        }).eq("session_id", row.session_id);
        console.log(`[Whop] claim fulfilled ${isWhopSubPlan(row.plan_id) ? "subscription" : "pack"} (user ${row.user_id || "none"}, session ${row.session_id})`);
      }
      return res.json({ status: "fulfilled", token: null, vin: null, credits: row.credits || 0 });
    }

    // status === "paid": atomically claim the fetch (only paid->fulfilling wins).
    const { data: claimed } = await supabaseService.from("whop_checkouts")
      .update({ status: "fulfilling" }).eq("session_id", row.session_id).eq("status", "paid").select().maybeSingle();
    if (!claimed) {
      const { data: fresh } = await supabaseService.from("whop_checkouts").select("delivered_token,vin").eq("session_id", row.session_id).maybeSingle();
      if (fresh?.delivered_token) return res.json({ status: "fulfilled", token: fresh.delivered_token, vin: fresh.vin, credits: 0 });
      return res.status(202).json({ status: "processing" });   // another request is fetching
    }
    try {
      let raw = await getReportData(row.vin, row.type), vehicle = row.vehicle || null;
      if (!raw) {
        const fetched = await cfcGetReport(row.vin, row.type);   // 1 provider credit (paid for)
        raw = fetched.raw; vehicle = fetched.vehicle;
        try { writeCache(row.vin, row.type, raw); } catch (_) {}
        await writeGlobalCache(row.vin, row.type, raw, vehicle);
      }
      const { token } = await createShareToken(row.vin, row.type, vehicle);
      const { user } = await getUser(req).catch(() => ({ user: null }));
      if (user && row.user_id && user.id === row.user_id) {     // logged-in → own it
        await supabaseService.from("vin_queries").upsert(
          { user_id: user.id, vin: row.vin, type: row.type, success: true, report_data: raw, vehicle },
          { onConflict: "user_id,vin,type" });
      }
      await supabaseService.from("whop_checkouts").update({
        status: "fulfilled", delivered_token: token, vehicle, fulfilled_at: new Date().toISOString(),
      }).eq("session_id", row.session_id);
      const emailTo = row.buyer_email || (user && user.email) || null;
      if (emailTo) sendReportEmail(emailTo, row.vin, vehicle, token, !row.user_id).catch((e) => console.warn("[Whop] report email failed:", e.message));
      console.log(`[Whop] claim fulfilled (vin ${row.vin}, session ${row.session_id}, email ${emailTo || "none"})`);
      return res.json({ status: "fulfilled", token, vin: row.vin, credits: 0 });
    } catch (e) {
      await supabaseService.from("whop_checkouts").update({ status: "paid" }).eq("session_id", row.session_id);  // revert so a retry works
      console.error("[Whop] claim fetch failed:", e.message);
      notifyOwner(`whop-fail:${row.vin}`,
        `AutoVINReveal: PAID Whop report fetch failed — ${row.vin}`,
        `A customer PAID via Whop but the provider fetch failed. Auto-retry continues every 5-10 min; ` +
        `you'll get a separate one-time STUCK alert if it still hasn't delivered after 45 min.\n\n` +
        `VIN: ${row.vin} (${row.type})\nBuyer: ${row.buyer_email || "unknown"}\nWhop session: ${row.session_id}\nError: ${e.message}`);
      return res.status(502).json({ error: "provider_error" });
    }
  } catch (e) {
    console.error("[Whop] /api/whop/claim error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// ── Anti-scraping: strict per-IP limit on /api/report ──────────────────────
// Legitimate users run 1-5 reports. Scrapers run hundreds.
const reportRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour window
  max: 30,                     // anonymous guests only (logged-in users are skipped below)
  keyGenerator: (req) => clientIp(req),
  message: { error: "rate_limited", message: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Never limit Render health checks.
    if (req.path === "/health") return true;
    // Logged-in users are already protected by the credit system and the
    // per-IP unique-VIN tracker, and re-opening a report they already own is
    // free — so this coarse anti-scrape limit must never block them.
    if (req.headers.authorization?.startsWith("Bearer ")) return true;
    return false;
  },
});

// ── Track suspicious VIN patterns across requests ─────────────────────────
const suspiciousIps = new Map(); // ip → { count, firstSeen, blocked }

function trackSuspicion(ip, vin) {
  const now = Date.now();
  let entry = suspiciousIps.get(ip);
  // Roll the 1-hour window: once it elapses, forget everything for this IP —
  // including any prior block. Without this, a blocked entry stayed blocked
  // until the next server restart (why "waiting days" never cleared it).
  if (!entry || (now - entry.firstSeen) > 60 * 60 * 1000) {
    entry = { count: 0, vins: new Set(), firstSeen: now, blocked: false };
  }
  entry.count++;
  entry.vins.add(vin);
  entry.lastSeen = now;

  // Auto-block if: 30+ unique VINs within the rolling 1-hour window.
  if (entry.vins.size >= 30) {
    if (!entry.blocked) {
      console.warn(`[AntiScrape] BLOCKED IP ${ip} — ${entry.vins.size} unique VINs in ${Math.round((now - entry.firstSeen)/60000)}min`);
    }
    entry.blocked = true;
  }
  suspiciousIps.set(ip, entry);
  return entry.blocked;
}

// ── Manually blocked IPs (add from your Render logs when you spot investigators)
// To block an IP: add it to your .env as BLOCKED_IPS=1.2.3.4,5.6.7.8
const BLOCKED_EMAIL_DOMAINS = [
  "carfax.com",
  "spglobal.com",
  "ihsmarkit.com",
  "experian.com",
];

function getBlockedIps() {
  return (process.env.BLOCKED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
}

function isBlockedIp(ip) {
  return getBlockedIps().some(blocked => ip.startsWith(blocked));
}

function isBlockedEmail(email) {
  if (!email) return false;
  const domain = email.split("@")[1]?.toLowerCase() || "";
  return BLOCKED_EMAIL_DOMAINS.includes(domain);
}

// ── Log every guest report purchase with full fingerprint ─────────────────
// This is how you identify CARFAX investigators:
// same IP buying single reports across multiple days, always different VINs
const guestPurchaseLog = new Map(); // ip → [{ vin, ts, email, ua }]

function logGuestPurchase(ip, vin, email, ua) {
  const log = guestPurchaseLog.get(ip) || [];
  log.push({ vin, ts: Date.now(), email: email || "", ua: (ua||"").slice(0,100) });
  guestPurchaseLog.set(ip, log);

  // Flag if same IP bought 3+ reports across sessions (even as guest)
  if (log.length >= 3) {
    const uniqueVins = new Set(log.map(l => l.vin));
    console.warn(`[InvestigatorFlag] IP ${ip} has run ${uniqueVins.size} unique VINs as guest. Emails: ${[...new Set(log.map(l=>l.email))].join(", ")}`);
  }
}

// Clean up old entries every hour
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [ip, entry] of suspiciousIps) {
    if (entry.lastSeen < cutoff) suspiciousIps.delete(ip);
  }
  // Also trim the guest purchase log so it doesn't grow unbounded.
  for (const [ip, log] of guestPurchaseLog) {
    const recent = log.filter(l => l.ts >= cutoff);
    if (recent.length) guestPurchaseLog.set(ip, recent);
    else guestPurchaseLog.delete(ip);
  }
}, 60 * 60 * 1000);

// Tighter limit for the unauthenticated provider-lookup endpoints (plate / vin-summary)
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "rate_limited", message: "Too many lookups. Please slow down." },
});

// Refund any charges left dangling by a prior crash (Stripe refunds only).
reconcileStalePendingCharges();

// Log provider configuration on startup
console.log(`[Provider] Active provider: ${REPORT_PROVIDER} — key configured: ${providerHasKey()}`);
console.log(`[Provider] Ready — daily limit: ${process.env.CCF_DAILY_HARD_LIMIT || "none"}`);

/* ================================================================
   Stripe Checkout
================================================================ */
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    // ── Cloudflare Turnstile verification ──────────────────────────────────
    // Blocks headless bots before they can reach Stripe
    const turnstileToken = req.body?.turnstile_token;
    if (process.env.TURNSTILE_SECRET_KEY) {
      if (!turnstileToken) {
        return res.status(403).json({ error: "captcha_required", message: "Please complete the verification." });
      }
      try {
        const verifyParams = new URLSearchParams();
        verifyParams.append("secret",   process.env.TURNSTILE_SECRET_KEY);
        verifyParams.append("response", turnstileToken);
        verifyParams.append("remoteip", req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip || "");
        const verifyRes = await axios.post(
          "https://challenges.cloudflare.com/turnstile/v0/siteverify",
          verifyParams.toString(),
          {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            validateStatus: () => true,
            timeout: 8000,
          }
        );
        if (!verifyRes.data?.success) {
          console.warn(`[Turnstile] Failed from ${req.ip}. Errors: ${JSON.stringify(verifyRes.data?.["error-codes"])}`);
          return res.status(403).json({ error: "captcha_failed", message: "Verification failed. Please try again." });
        }
      } catch (turnstileErr) {
        // Cloudflare unreachable — log and allow through rather than blocking real users
        console.error(`[Turnstile] Verification request failed: ${turnstileErr.message} — allowing through`);
      }
    }
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

    const isTwentyPack = price_id === "STRIPE_PRICE_20PACK" || price_id === "20pack";
    const isFivePack   = price_id === "STRIPE_PRICE_5PACK"  || price_id === "5pack";

    // Bundles must be tied to an account, or the webhook can't store the credits
    // (guest would pay and receive nothing).
    if ((isTwentyPack || isFivePack) && !userId) {
      return res.status(401).json({ error: "login_required", message: "Please sign in to buy a bundle." });
    }

    // A single report is for one specific vehicle — require a VIN.
    if (!isTwentyPack && !isFivePack && !vin) {
      return res.status(422).json({ error: "vin_required", message: "Please enter a VIN — single reports are for one specific vehicle." });
    }

    let priceLive = PRICE_SINGLE;
    let intent    = vin ? "buy_report" : "buy_credit_single";
    if (isTwentyPack)    { priceLive = PRICE_20PACK; intent = "buy_credits_20pack"; }
    else if (isFivePack) { priceLive = PRICE_5PACK;  intent = "buy_credits_5pack"; }

    if (!priceLive) {
      console.error(`[Stripe] Price ID missing — price_id:${price_id} PRICE_SINGLE:${PRICE_SINGLE} PRICE_5PACK:${PRICE_5PACK} PRICE_20PACK:${PRICE_20PACK}`);
      return res.status(500).json({ error: "price_not_configured", message: "Payment configuration error. Please contact support." });
    }

    const session = await stripeDefault.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      currency: "usd",
      line_items: [{ price: priceLive, quantity: 1 }],
      payment_intent_data: {
        description: vin
          ? `AutoVINReveal – VIN: ${vin}`
          : isTwentyPack ? "AutoVINReveal – 20 Report Bundle"
          : isFivePack ? "AutoVINReveal – 5 Report Bundle"
          : "AutoVINReveal – 1 Report Credit",
        metadata: { ...(vin ? { vin } : {}) },
      },
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&intent=${encodeURIComponent(intent)}${vin ? `&vin=${encodeURIComponent(vin)}` : ""}`,
      cancel_url:  `${SITE_URL}/?checkout=cancel`,
      ...(userId ? { client_reference_id: userId } : {}),
      metadata: {
        ...(userId      ? { user_id: userId } : {}),
        ...(vin         ? { vin }              : {}),
        ...(report_type ? { report_type }      : {}),
        intent,
        // Fingerprint every checkout so guest investigators are traceable
        client_ip: req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip || "",
        client_ua: (req.headers["user-agent"] || "").slice(0, 200),
      },
    });

    // Log guest purchases for investigator detection
    if (!userId && vin) {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
      logGuestPurchase(ip, vin, "", req.headers["user-agent"]);
      console.log(`[GuestPurchase] IP: ${ip} VIN: ${vin} UA: ${(req.headers["user-agent"]||"").slice(0,80)}`);
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err?.message || err);
    const msg = err?.message || "Stripe error";
    res.status(500).json({ error: "stripe_error", message: msg });
  }
});

/* ================================================================
   Subscription Checkout
================================================================ */
app.post("/api/create-subscription-session", async (req, res) => {
  try {
    const { price_id } = req.body || {};
    const { user } = await getUser(req);
    if (!user) return res.status(401).json({ error: "Login required to subscribe" });

    const validPrices = [SUB_STARTER, SUB_PRO, SUB_PREMIUM].filter(Boolean);
    if (!validPrices.includes(price_id)) {
      return res.status(400).json({ error: "Invalid subscription price" });
    }

    const session = await stripeDefault.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: price_id, quantity: 1 }],
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&intent=subscription`,
      cancel_url:  `${SITE_URL}/?checkout=cancel`,
      client_reference_id: user.id,
      metadata: { user_id: user.id, price_id },
      subscription_data: { metadata: { user_id: user.id } },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Subscription checkout error:", err);
    res.status(500).json({ error: "Subscription error" });
  }
});

/* ================================================================
   Cancel Subscription
================================================================ */
app.post("/api/cancel-subscription", async (req, res) => {
  try {
    const { user } = await getUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const { data } = await supabaseService
      .from("credits")
      .select("stripe_subscription_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!data?.stripe_subscription_id) {
      return res.status(404).json({ error: "No active subscription" });
    }

    await stripeDefault.subscriptions.cancel(data.stripe_subscription_id);
    await supabaseService.from("credits")
      .update({ stripe_subscription_id: null })
      .eq("user_id", user.id);

    res.json({ ok: true });
  } catch (err) {
    console.error("Cancel subscription error:", err);
    res.status(500).json({ error: "Cancellation failed" });
  }
});

/* ================================================================
   Provider proxy — cheapestcarfax.com fetches cheapcarfax reports
   through this server because only OUR outbound IP (74.220.48.251)
   is whitelisted with panel.cheapcarfax.net. Verbatim passthrough:
   one attempt, status + JSON body relayed as-is so the caller's own
   retry/error handling applies. Auth: x-proxy-secret header.
================================================================ */
app.get("/api/provider-proxy/cheapcarfax/:vin", async (req, res) => {
  const given = String(req.headers["x-proxy-secret"] || "");
  const ok = PROVIDER_PROXY_SECRET
    && given.length === PROVIDER_PROXY_SECRET.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PROVIDER_PROXY_SECRET));
  if (!ok) return res.status(401).json({ message: "Unauthorized" });

  const vin = String(req.params.vin || "").trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return res.status(400).json({ message: "VIN is required and must be 17 characters" });
  if (!CHEAPCARFAX_KEY) return res.status(503).json({ message: "CHEAPCARFAX_API_KEY not set on proxy" });

  try {
    const r = await axios.get(`${CHEAPCARFAX_BASE}/api/carfax/vin/${vin}/html`, {
      headers: { "x-api-key": CHEAPCARFAX_KEY },
      timeout: 45000,
      validateStatus: () => true,
    });
    console.log(`[ProviderProxy] cheapcarfax ${vin} → ${r.status} (for CFC)`);
    const body = (r.data && typeof r.data === "object") ? r.data : { message: String(r.data ?? "").slice(0, 500) };
    res.status(r.status).json(body);
  } catch (err) {
    console.error(`[ProviderProxy] cheapcarfax ${vin} upstream error: ${err.message}`);
    res.status(502).json({ message: "Report Not Available! (proxy upstream error: " + err.message + ")" });
  }
});

app.get("/api/myip", async (req, res) => {
  const yourIp = clientIp(req) || req.socket.remoteAddress;
  // The server's outbound IP is infra detail (whitelisted with the report provider).
  // Only reveal it to an authenticated ops caller (?key = the provider-proxy secret);
  // the public just gets their own IP.
  const authed = PROVIDER_PROXY_SECRET && req.query.key === PROVIDER_PROXY_SECRET;
  if (!authed) return res.json({ your_ip: yourIp });
  let serverOutboundIp = null;
  try {
    const r = await axios.get("https://api.ipify.org?format=json", { timeout: 8000 });
    serverOutboundIp = r.data && r.data.ip;
  } catch (e) { serverOutboundIp = "unavailable (" + e.message + ")"; }
  res.json({ your_ip: yourIp, server_outbound_ip: serverOutboundIp });
});

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
    const subBal = await getSubCreditBalance(req.params.user_id);
    res.json({ balance: (data?.balance ?? 0) + subBal });
  } catch { res.status(500).json({ error: "Server error" }); }
});

/* ================================================================
   NOWPayments — crypto (USDT on BSC) checkout
   Requires sign-in for all plans so the IPN can always credit an account.
================================================================ */
const NP_API_KEY    = process.env.NOWPAYMENTS_API_KEY || "";
const NP_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || "";
const NP_BASE       = "https://api.nowpayments.io/v1";
const NP_AMOUNTS = {
  single: { usd: 5.99,  credits: 1  },
  five:   { usd: 20.00, credits: 5  },
  twenty: { usd: 58.00, credits: 20 },
};

// Recursively sort object keys for NOWPayments IPN HMAC verification
function sortObjectKeys(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortObjectKeys(obj[k]); return acc; }, {});
}

// Schedule the crypto reconcile sweep (defined above; NP_API_KEY is in scope here).
if (NP_API_KEY) {
  setInterval(reconcileCryptoPayments, 10 * 60 * 1000);
  setTimeout(reconcileCryptoPayments, 80 * 1000);
}

app.post("/api/crypto/create-payment", async (req, res) => {
  try {
    if (!NP_API_KEY) return res.status(503).json({ error: "Crypto payments not configured" });

    const { price_key } = req.body || {};
    const plan = NP_AMOUNTS[price_key];
    if (!plan) return res.status(400).json({ error: "Invalid price key" });

    // Crypto is async — require an account so the IPN can credit it.
    const { user } = await getUser(req);
    if (!user) return res.status(401).json({ error: "login_required", message: "Please sign in to pay with crypto." });

    const orderId = `avr-${price_key}-${user.id}-${Date.now()}`;
    const payload = {
      price_amount:        plan.usd,
      price_currency:      "usd",
      pay_currency:        "usdtbsc",        // USDT on BSC — cheapest fees
      order_id:            orderId,
      order_description:   `AutoVINReveal ${plan.credits} credit${plan.credits !== 1 ? "s" : ""}`,
      ipn_callback_url:    `${SITE_URL}/api/crypto/ipn`,
      success_url:         `${SITE_URL}/?crypto=success&order=${encodeURIComponent(orderId)}`,
      cancel_url:          `${SITE_URL}/?crypto=cancel`,
      is_fixed_rate:       false,
      is_fee_paid_by_user: false,
    };

    const r = await axios.post(`${NP_BASE}/payment`, payload, {
      headers: { "x-api-key": NP_API_KEY, "Content-Type": "application/json" },
      timeout: 15000, validateStatus: () => true,
    });
    if (r.status !== 200 && r.status !== 201) {
      console.error("[NP] create error", r.status, JSON.stringify(r.data).slice(0, 300));
      return res.status(502).json({ error: "Crypto provider error — please try again" });
    }

    const payment = r.data;
    try {
      await supabaseService.from("crypto_payments").insert({
        payment_id: String(payment.payment_id),
        order_id:   orderId,
        price_key,
        credits:    plan.credits,
        user_id:    user.id,
        status:     "waiting",
        created_at: new Date().toISOString(),
      });
    } catch (e) { console.warn("[NP] store payment failed:", e.message); }

    res.json({
      payment_id:               payment.payment_id,
      pay_address:              payment.pay_address,
      pay_amount:               payment.pay_amount,
      pay_currency:             payment.pay_currency,
      price_amount:             payment.price_amount,
      price_currency:           payment.price_currency,
      expiration_estimate_date: payment.expiration_estimate_date,
      order_id:                 orderId,
    });
  } catch (e) {
    console.error("[NP] create unhandled:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/crypto/status/:payment_id", async (req, res) => {
  try {
    if (!NP_API_KEY) return res.status(503).json({ error: "Not configured" });
    const r = await axios.get(`${NP_BASE}/payment/${req.params.payment_id}`, {
      headers: { "x-api-key": NP_API_KEY }, timeout: 8000, validateStatus: () => true,
    });
    if (r.status !== 200) return res.status(r.status).json({ error: "Payment not found" });
    res.json(r.data);
  } catch { res.status(500).json({ error: "Server error" }); }
});

app.post("/api/crypto/ipn", async (req, res) => {
  // Verify NOWPayments signature (HMAC-SHA512 over the sorted JSON body).
  // FAIL CLOSED: with no secret configured this is a credit-minting endpoint anyone
  // could POST a forged "finished" to, so refuse rather than trust an unsigned body.
  if (!NP_IPN_SECRET) {
    console.error("[NP IPN] NOWPAYMENTS_IPN_SECRET not set — refusing to process (fail closed).");
    return res.status(503).send("IPN not configured");
  }
  {
    const sig = req.headers["x-nowpayments-sig"];
    if (!sig) return res.status(400).send("Missing signature");
    const expected = crypto.createHmac("sha512", NP_IPN_SECRET)
      .update(JSON.stringify(sortObjectKeys(req.body)))
      .digest("hex");
    if (sig !== expected) { console.warn("[NP IPN] Invalid signature"); return res.status(401).send("Invalid signature"); }
  }

  const { payment_id, payment_status, order_id, pay_amount, actually_paid, pay_currency } = req.body || {};
  console.log(`[NP IPN] payment_id=${payment_id} status=${payment_status} order=${order_id}`);

  // Alert the owner on a problem status (underpaid / failed / refunded / expired) so it
  // can be resolved manually — no credits are granted for these.
  if (["partially_paid", "failed", "refunded", "expired"].includes(payment_status) && mailer) {
    try {
      const { data: p } = await supabaseService.from("crypto_payments").select("*").eq("payment_id", String(payment_id)).maybeSingle();
      const ownerTo = CFC_OWNER_EMAIL || SMTP_USER;
      if (ownerTo) {
        await mailer.sendMail({
          from: SMTP_FROM, to: ownerTo,
          subject: `AutoVINReveal crypto ${payment_status} — ${payment_id}`,
          text: [
            `A crypto payment came in as "${payment_status}" — no credits were granted.`,
            ``,
            `Payment ID:    ${payment_id}`,
            `Order:         ${order_id}`,
            `Plan:          ${p?.price_key || "?"} (${p?.credits ?? "?"} credits)`,
            `User:          ${p?.user_id || "guest"}`,
            `Expected:      ${pay_amount ?? "?"} ${(pay_currency || "").toUpperCase()}`,
            `Actually paid: ${actually_paid ?? "?"}`,
            ``,
            `Resolve in the NOWPayments dashboard (request top-up or refund), then add credits manually if needed.`,
          ].join("\n"),
        });
      }
    } catch (e) { console.warn("[NP IPN] owner alert failed:", e.message); }
  }

  // Chargeback/refund — reverse a previously-granted crypto purchase (clamped so the
  // balance never goes negative), and mark the row so a redelivered event won't
  // double-reverse. Only fulfilled orders have credits to reverse.
  if (["refunded", "failed"].includes(payment_status) && supabaseService) {
    try {
      const { data: row } = await supabaseService.from("crypto_payments")
        .select("user_id, credits, status, order_id").eq("payment_id", String(payment_id)).maybeSingle();
      if (row && row.status === "fulfilled") {
        const rev = row.user_id ? await reverseCredits(row.user_id, row.credits) : 0;
        await supabaseService.from("crypto_payments").update({ status: payment_status }).eq("order_id", row.order_id).eq("status", "fulfilled");
        console.log(`[NP IPN] ${payment_status} — reversed ${rev} credits from ${row.user_id || "guest"} (order ${row.order_id})`);
      }
    } catch (e) { console.warn("[NP IPN] refund reversal failed:", e.message); }
  }

  if (!["finished", "confirmed"].includes(payment_status)) {
    return res.status(200).json({ ok: true, status: payment_status });
  }

  try {
    // Match by order_id (stable) first — crypto2crypto conversions change the
    // payment_id, so looking up by the original id misses them. Fall back to id.
    let pending = null;
    if (order_id) {
      const { data } = await supabaseService.from("crypto_payments").select("*").eq("order_id", order_id).maybeSingle();
      pending = data || null;
    }
    if (!pending && payment_id) {
      const { data } = await supabaseService.from("crypto_payments").select("*").eq("payment_id", String(payment_id)).maybeSingle();
      pending = data || null;
    }
    if (!pending) { console.warn(`[NP IPN] No pending payment for order ${order_id} / id ${payment_id}`); return res.status(200).json({ ok: true }); }

    // Atomically CLAIM the row (non-fulfilled -> fulfilled) BEFORE granting.
    // Concurrent confirmed+finished callbacks race here; Postgres row-locks the
    // update so only the one that actually flips the row grants — never twice.
    const { data: claimed } = await supabaseService.from("crypto_payments")
      .update({ status: "fulfilled", fulfilled_at: new Date().toISOString() })
      .eq("order_id", pending.order_id)
      .neq("status", "fulfilled")
      .select()
      .maybeSingle();
    if (!claimed) return res.status(200).json({ ok: true }); // already fulfilled/claimed

    if (claimed.user_id) {
      await addCreditsAtomic(claimed.user_id, claimed.credits);
      console.log(`[NP IPN] +${claimed.credits} credits → user ${claimed.user_id}`);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[NP IPN] Fulfillment error:", e.message);
    res.status(500).json({ error: "Fulfillment error" });
  }
});

/* ================================================================
   Main Report Logic
================================================================ */
app.post("/api/report", reportRateLimit, async (req, res) => {
  let targetVin       = "";
  let type            = "carfax";
  let currentUser     = null;
  let oneTimeSession  = null;
  let alreadyOwned    = false;
  let pendingChargeId = null;

  try {
    const {
      vin,
      type:           reqType,
      as:             as          = "html",
      allowLive:      allowLiveRaw,
      oneTimeSession: reqSession,
    } = req.body || {};

    type           = (reqType || "carfax").toLowerCase();
    const allowLive = allowLiveRaw !== false;
    oneTimeSession  = reqSession;

    // 1. Resolve VIN
    targetVin = (vin || "").trim().toUpperCase();
    if (!targetVin) return res.status(400).json({ error: "vin_required" });

    // 2. Validate VIN
    const v = validateVin(targetVin);
    if (!v.ok) return res.status(422).json({ error: "invalid_vin", reason: v.code, message: v.msg });
    targetVin = v.vin;

    // 2b. Anti-scraping checks
    const clientIp2 = clientIp(req);
    const ua = req.headers["user-agent"] || "";

    // Block missing or bot-like User-Agents
    const suspiciousUA = !ua ||
      /python-requests|curl|wget|scrapy|go-http|java\/|libwww|axios\/[0-9]|node-fetch|bot|spider|crawl/i.test(ua);
    if (suspiciousUA) {
      console.warn(`[AntiScrape] Blocked suspicious UA from ${clientIp2}: "${ua.slice(0, 80)}"`);
      return res.status(403).json({ error: "forbidden", message: "Access denied." });
    }

    // Block known CARFAX/investigator IPs silently — return fake success with no data
    if (isBlockedIp(clientIp2)) {
      console.warn(`[AntiCAR] Blocked known investigator IP: ${clientIp2} VIN: ${targetVin}`);
      // Return fake 200 so they don't know they're blocked
      return res.status(200).send("<html><body><p>Report loading...</p></body></html>");
    }

    // Require either a logged-in user OR a valid one-time session
    // No anonymous free-for-all lookups
    const { user: earlyUser } = await getUser(req);
    if (!earlyUser && !oneTimeSession) {
      return res.status(401).json({ error: "auth_required", message: "Please log in to run reports." });
    }

    // 3. Check shared cache (TTL-bound — used for non-owners / fast path)
    let raw = await getReportData(targetVin, type);

    // 4. Check ownership. A signed-in owner keeps access to their purchased copy
    // FOREVER — we load their stored report directly, bypassing the 20-day TTL.
    // `refresh:true` is a VOLUNTARY re-pull for newer data (charged 1 credit).
    const forceRefresh = req.body?.refresh === true && allowLive;
    let ownedAgeDays = null;
    let ownedVehicle = null;
    if (!oneTimeSession) {
      const { user } = await getUser(req);
      currentUser = user;
      if (currentUser) {
        const { data: ownRows } = await supabaseService
          .from("vin_queries")
          .select("id, report_data, created_at, vehicle")
          .eq("user_id", currentUser.id)
          .eq("vin", targetVin)
          .eq("type", type)
          .eq("success", true)
          .order("created_at", { ascending: false })
          .limit(1);
        const past = ownRows?.[0];
        if (past) {
          alreadyOwned = true;
          ownedVehicle = past.vehicle || null;
          if (past.created_at) ownedAgeDays = Math.floor((Date.now() - new Date(past.created_at).getTime()) / 86400000);
          // Owner's permanent copy overrides the TTL-bound shared cache.
          if (past.report_data && !forceRefresh) raw = past.report_data;
        }
      }
    }
    // Voluntary refetch: ignore any cached copy and pull fresh (charged below).
    if (forceRefresh) raw = null;

    // ── 5. Deliverability ────────────────────────────────────────
    // Nothing loadable and we're not allowed to fetch live.
    if (!raw && !allowLive) {
      if (alreadyOwned) {
        // Owner's stored copy isn't loadable right now — they own it, so re-pulling
        // is FREE. Client should retry with allowLive:true.
        return res.status(404).json({
          error: "report_expired",
          message: "Re-opening your saved report… you own it, so this is free.",
          vin: targetVin,
          can_refetch: true,
          owned: true,
        });
      }
      // Non-owner trying to view a report they haven't bought.
      return res.status(402).json({ error: "payment_required", message: "You don't own this report yet." });
    }

    // ── 6. Payment gate ──────────────────────────────────────────
    // Owners view their purchased copy FREE, forever — and a free auto-recovery
    // pull if their stored copy is ever missing. Only a VOLUNTARY refresh (for
    // newer data) costs a credit. Non-owners always pay.
    const freeAccess = alreadyOwned && !forceRefresh;

    // Anti-scrape: only brand-new (non-owned) lookups count toward the per-IP
    // unique-VIN limit. Re-opening reports you already own never trips it.
    if (!freeAccess && trackSuspicion(clientIp2, targetVin)) {
      return res.status(429).json({ error: "rate_limited", message: "Too many requests. Please try again later." });
    }

    if (!freeAccess) {
      if (oneTimeSession) {
        try {
          // Stripe one-time guest receipt only (PayPal removed).
          const sStripe = stripeForId(oneTimeSession);
          const s       = await sStripe.checkout.sessions.retrieve(oneTimeSession);
          if (s.payment_status !== "paid") throw new Error("unpaid");
          await markSessionConsumed(oneTimeSession);
          pendingChargeId = await createPendingCharge({ sessionId: oneTimeSession, vin: targetVin });
        } catch (e) {
          if (e.message === "SESSION_ALREADY_CONSUMED") return res.status(400).json({ error: "receipt_already_used" });
          return res.status(400).json({ error: "receipt_invalid" });
        }
      } else if (currentUser) {
        pendingChargeId = await createPendingCharge({ userId: currentUser.id, vin: targetVin });
        // Spend expiring subscription credits first (so they're used before they
        // lapse); otherwise the permanent balance via use_credit_for_vin. The report
        // is logged to vin_queries post-fetch regardless of which credit type paid.
        const { data: usedSub } = await supabaseService.rpc("cfc_use_sub_credit", { uid: currentUser.id });
        if (usedSub !== true) {
          const { error: rpcErr } = await supabaseForToken(
            req.headers.authorization?.split(" ")[1]
          ).rpc("use_credit_for_vin", { p_vin: targetVin, p_result_url: null });
          if (rpcErr) {
            await resolvePendingCharge(pendingChargeId);
            pendingChargeId = null;
            return res.status(402).json({ error: "insufficient_credits" });
          }
        }
      } else {
        return res.status(401).json({ error: "purchase_required" });
      }
    }

    // ── 7. Live fetch (only when not already cached) ─────────────
    let justFetched = false;
    let fetchedVehicle = null;
    if (!raw) {
      try {
        const fetched = await cfcGetReport(targetVin, type);
        raw           = fetched.raw;
        fetchedVehicle = fetched.vehicle;
        justFetched   = true;
        writeCache(targetVin, type, raw);
        // Guests have no vin_queries row — persist their fresh pull to the global
        // cache so the next buyer of this VIN reuses it (no double provider charge).
        if (!currentUser) await writeGlobalCache(targetVin, type, raw, fetchedVehicle);
      } catch (e) {
        console.error(`[Fetch Failed] User: ${currentUser?.id || "guest"} | VIN: ${targetVin} | Err: ${e.message}`);
        if (pendingChargeId) {
          await refundAndResolve(pendingChargeId, currentUser?.id || null, oneTimeSession,
            `provider fetch failed for VIN ${targetVin} (${type}): ${e.message}`);
          pendingChargeId = null;
        }
        const msg = String(e.message || "");
        // The pending charge was already refunded above (refundAndResolve), so the
        // user is never charged regardless of which branch we return.

        // Genuinely invalid / missing VIN — safe to tell the user to re-check it.
        const notFound =
          msg.includes("CS_404") ||
          /invalid.*vin|vin.*not.*found|not\s*found|no\s+(record|report|data|results?)|does\s*n['o]?t\s+exist|no\s+vehicle/i.test(msg);

        // Provider HAS the VIN but couldn't produce the report right now (often
        // transient). Do NOT blame the user's VIN — be honest and suggest retry.
        const unavailable =
          msg.includes("RV_UNAVAILABLE") ||
          msg.includes("RV_EMPTY_RESPONSE") ||
          /report\s+not\s+available|not\s+available|unavailable|try\s+again|still\s+(generating|processing)|in\s+progress|temporar/i.test(msg);

        if (notFound) {
          return res.status(422).json({ error: "invalid_vin", reason: "remote_reject", message: "VIN not found — please double-check it. You have not been charged." });
        }
        if (unavailable) {
          return res.status(503).json({ error: "report_unavailable", message: "This report isn’t available for this VIN right now — our data provider couldn’t generate it. You have not been charged. Please try again in a few minutes, or try a different VIN." });
        }
        return res.status(502).json({ error: "provider_error", message: "Report generation failed. You have been refunded." });
      }
    }

    if (!raw) return res.status(404).json({ error: "not_found", message: "No report found." });

    // ── 8. Record ownership / refresh the user's stored copy ─────
    // Store on a fresh fetch, or to create the row for a paying non-owner so they
    // own it next time. Owners re-viewing from cache skip this (no wasted write).
    // Resolve a "YEAR Make Model" label for history search + share previews.
    let vehicleLabel = fetchedVehicle || ownedVehicle || null;
    if (!vehicleLabel && raw && currentUser && (justFetched || !alreadyOwned)) {
      try { const dec = decodeReportBase64(raw); if (dec.kind === "html") vehicleLabel = extractVehicleLabel(dec.html); } catch (_) {}
    }

    if (currentUser && (justFetched || !alreadyOwned)) {
      const { data: existing } = await supabaseService
        .from("vin_queries")
        .select("id")
        .eq("user_id", currentUser.id).eq("vin", targetVin).eq("type", type)
        .maybeSingle();
      if (existing?.id) {
        // Bump created_at so the 20-day cache window restarts from this fresh pull.
        const upd = { report_data: raw, success: true, created_at: new Date().toISOString() };
        if (vehicleLabel) upd.vehicle = vehicleLabel;
        const { error: updErr } = await supabaseService
          .from("vin_queries").update(upd).eq("id", existing.id);
        if (updErr) console.error("[DB] Update report_data failed:", updErr.message);
      } else {
        const { error: insErr } = await supabaseService
          .from("vin_queries").insert({ user_id: currentUser.id, vin: targetVin, type, report_data: raw, success: true, vehicle: vehicleLabel || null });
        if (insErr) console.error("[DB] Insert report failed:", insErr.message);
      }
    }

    // Tell the client what we served: owner status, age of the stored copy, and the
    // vehicle label — used to show the optional "Get updated report" button.
    res.setHeader("X-Report-Owned", (alreadyOwned || (currentUser && justFetched)) ? "1" : "0");
    if (ownedAgeDays != null && !justFetched) res.setHeader("X-Report-Age-Days", String(ownedAgeDays));
    const labelForHeader = vehicleLabel || ownedVehicle;
    if (labelForHeader) res.setHeader("X-Report-Vehicle", encodeURIComponent(labelForHeader));

    // 6. Deliver
    const decoded = decodeReportBase64(raw);

    // PDF handled client-side via html2pdf.js — no server-side PDF generation needed

    if (decoded.kind === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      let reportHtml = injectReportChrome(decoded.html);

      // ── Invisible watermark — ties every served report to the user ──────
      // Even if CARFAX screenshots or scrapes the rendered report,
      // the watermark proves it came from a specific AutoVINReveal account.
      const userLabel = currentUser?.email || currentUser?.id || oneTimeSession || "guest";
      const watermark = `<!-- avr:${userLabel}:${targetVin}:${Date.now()} -->` +
        `<span style="position:fixed;bottom:-9999px;left:-9999px;opacity:0;font-size:1px;pointer-events:none;user-select:none;" aria-hidden="true">` +
        `avr-report:${Buffer.from(userLabel).toString("base64")}:${targetVin}` +
        `</span>`;
      reportHtml = reportHtml.replace("</body>", watermark + "</body>");

      if (pendingChargeId) { await resolvePendingCharge(pendingChargeId); pendingChargeId = null; }
      return res.send(reportHtml);
    }

    if (decoded.kind === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      if (pendingChargeId) { await resolvePendingCharge(pendingChargeId); pendingChargeId = null; }
      return res.send(decoded.buffer);
    }

    if (pendingChargeId) {
      console.error(`[Delivery Failed] User: ${currentUser?.id || "guest"} | Bad format. Refunding.`);
      await refundAndResolve(pendingChargeId, currentUser?.id || null, oneTimeSession,
        `provider returned unusable report format for VIN ${targetVin} (${type})`);
      pendingChargeId = null;
      return res.status(422).json({ error: "provider_error", message: "Report format error. You have been refunded." });
    }

    return res.status(500).json({ error: "unsupported_content" });

  } catch (err) {
    if (pendingChargeId) {
      try { await refundAndResolve(pendingChargeId, currentUser?.id || null, oneTimeSession,
        `unhandled server error for VIN ${targetVin}: ${err.message}`); }
      catch (refundErr) { console.error("[Critical] Outer-catch refund failed:", refundErr.message); }
    }
    console.error("Critical server error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ================================================================
   Email Report — EMAIL-PDF FIX
   Emails the report as a link (PDF attachment not available server-side)
   to generate a real PDF attachment. Falls back to a styled link
   email if PDF generation fails.
================================================================ */
app.post("/api/email-report", async (req, res) => {
  try {
    if (!mailer) return res.status(500).json({ error: "email_not_configured" });

    const { user } = await getUser(req);

    const { to, vin, type = "carfax", oneTimeSession } = req.body || {};
    if (!to || !String(to).includes("@")) return res.status(400).json({ error: "invalid_to" });

    const targetVin = (vin || "").trim().toUpperCase();
    if (!targetVin) return res.status(400).json({ error: "vin_required" });
    const typeL = (type || "carfax").toLowerCase();

    if (user) {
      // Logged-in: only the owner may email their report (was previously
      // unauthenticated — anyone who knew a cached VIN could email that report).
      const { data: owned } = await supabaseService
        .from("vin_queries")
        .select("id")
        .eq("user_id", user.id).eq("vin", targetVin).eq("type", typeL).eq("success", true)
        .maybeSingle();
      if (!owned) return res.status(403).json({ error: "report_not_owned" });
    } else {
      // Guest: authorize via the one-time Stripe checkout receipt. Verify the
      // session is paid and its metadata.vin matches the requested VIN. This is a
      // read-only Stripe check (no markSessionConsumed), so guests can resend.
      if (!oneTimeSession) return res.status(401).json({ error: "unauthorized" });
      try {
        const sStripe = stripeForId(oneTimeSession);
        const s = await sStripe.checkout.sessions.retrieve(oneTimeSession);
        if (s.payment_status !== "paid") return res.status(403).json({ error: "receipt_unpaid" });
        if ((s.metadata?.vin || "").trim().toUpperCase() !== targetVin) {
          return res.status(403).json({ error: "receipt_vin_mismatch" });
        }
      } catch {
        return res.status(403).json({ error: "receipt_invalid" });
      }
    }

    const raw = await getReportData(targetVin, typeL);
    if (!raw) return res.status(404).json({ error: "not_cached" });

    const decoded = decodeReportBase64(raw);
    const subject = `Your ${typeL.toUpperCase()} Vehicle History Report — ${targetVin}`;

    // If the cached report is already a PDF, attach it directly.
    if (decoded.kind === "pdf") {
      await mailer.sendMail({
        from: SMTP_FROM, to, subject,
        text: `Your vehicle history report for VIN ${targetVin} is attached as a PDF.`,
        attachments: [{
          filename:    `${targetVin}-${typeL}-report.pdf`,
          content:     decoded.buffer,
          contentType: "application/pdf",
        }],
      });
      return res.json({ ok: true, format: "pdf" });
    }

    // HTML report — email a tokenized share link (the old /view-report/:vin route
    // never existed, so that link 404'd to the homepage).
    const { token } = await createShareToken(targetVin, typeL);
    const reportUrl = `${SITE_URL}/view/${token}`;
    await mailer.sendMail({
      from: SMTP_FROM, to, subject,
      text: [
        `Your vehicle history report for VIN ${targetVin} is ready.`,
        ``,
        `View your report here: ${reportUrl}`,
        ``,
        `To save as PDF: open the link then press Ctrl+P (Windows) or Cmd+P (Mac) and choose Save as PDF.`,
      ].join("\n"),
      html: `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#1e293b;">
  <div style="background:#1d4ed8;padding:24px 32px;border-radius:8px 8px 0 0;">
    <h1 style="color:white;margin:0;font-size:20px;">Vehicle History Report Ready</h1>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;padding:32px;border-radius:0 0 8px 8px;">
    <p>Your CARFAX report for <strong>${targetVin}</strong> is ready to view.</p>
    <p style="margin:24px 0;">
      <a href="${reportUrl}" style="background:#1d4ed8;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">View Report</a>
    </p>
    <p style="color:#64748b;font-size:13px;">
      To save as PDF: open the report then press <strong>Ctrl+P</strong> / <strong>Cmd+P</strong> and choose <strong>Save as PDF</strong>.
    </p>
  </div>
</body></html>`,
    });
    return res.json({ ok: true, format: "link_fallback" });
  } catch { return res.status(500).json({ error: "email_failed" }); }
});

/* ================================================================
   User History — returns the logged-in user's vin_queries records
   Used by history.html to merge server-side records with localStorage.
================================================================ */
app.get("/api/history", async (req, res) => {
  try {
    const { user } = await getUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const { data, error } = await supabaseService
      .from("vin_queries")
      .select("vin, type, success, created_at, vehicle")
      .eq("user_id", user.id)
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      console.error("[/api/history] Supabase error:", error.message);
      return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true, rows: data || [] });
  } catch { res.status(500).json({ error: "Server error" }); }
});

/* ================================================================
   Share Tokens
================================================================ */
app.post("/api/share", async (req, res) => {
  try {
    const { user } = await getUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const { vin, type = "carfax" } = req.body || {};
    if (!vin) return res.status(400).json({ error: "vin required" });
    const vinU  = vin.toUpperCase().trim();
    const typeL = (type || "carfax").toLowerCase();

    // Only the owner of a report may create a share link for it.
    const { data: owned } = await supabaseService
      .from("vin_queries")
      .select("id, report_data, vehicle")
      .eq("user_id", user.id).eq("vin", vinU).eq("type", typeL).eq("success", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!owned) return res.status(403).json({ error: "report_not_owned" });

    // Owner's permanent copy (no TTL); fall back to the shared cache.
    const raw = owned.report_data || await getReportData(vinU, typeL);
    if (!raw) return res.status(404).json({ error: "not_cached" });

    // Prefer the stored "YEAR Make Model" label (authoritative from the provider);
    // else decode the VIN (NHTSA), else parse the report's embedded data.
    let vehicle = owned.vehicle || null;
    if (!vehicle) vehicle = await decodeVinLabel(vinU);
    if (!vehicle) {
      const dec = decodeReportBase64(raw);
      if (dec?.kind === "html") vehicle = extractVehicleLabel(dec.html);
    }

    const { token, expiresAt } = await createShareToken(vinU, typeL, vehicle);
    res.json({ url: `${SITE_URL}/view/${token}`, expiresAt });
  } catch { res.status(500).json({ error: "Failed to create share link" }); }
});

app.get("/view/:token", async (req, res) => {
  try {
    const meta = await getShareToken(req.params.token);
    if (!meta) return res.status(404).send("Link expired or not found");
    // Shared links stay valid for the token's lifetime even past the 20-day cache
    // TTL — fall back to the latest stored copy for this VIN/type.
    let raw = await getReportData(meta.vin, meta.type);
    if (!raw) {
      const { data: stored } = await supabaseService
        .from("vin_queries")
        .select("report_data")
        .eq("vin", meta.vin).eq("type", meta.type)
        .not("report_data", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      raw = stored?.report_data || null;
    }
    if (!raw)  return res.status(404).send("Report not found");
    const decoded = decodeReportBase64(raw);
    if (decoded.kind === "html") {
      res.setHeader("Content-Type", "text/html");
      // BLANK-PAGE FIX: same injection as main report route, plus share-preview
      // meta so links unfurl with the vehicle's year+model.
      // Prefer the label stored when the link was created; fall back for older
      // tokens (report-embedded data, then an authoritative VIN decode).
      const vehicle  = meta.vehicle || extractVehicleLabel(decoded.html) || await decodeVinLabel(meta.vin);
      const shareUrl = `${SITE_URL}/view/${req.params.token}`;
      return res.send(injectShareMeta(injectReportChrome(decoded.html), { vin: meta.vin, vehicle, url: shareUrl }));
    }
    if (decoded.kind === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      return res.send(decoded.buffer);
    }
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
  // Fail closed — with no password configured, an empty provided password would
  // timing-safe-match an empty expected and log the attacker in.
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "admin_disabled" });
  const provided = req.body?.password || "";
  const expected = ADMIN_PASSWORD;
  // FIX-1: timingSafeEqual only — no plain === short-circuit
  const a = Buffer.alloc(64); const b = Buffer.alloc(64);
  Buffer.from(provided).copy(a); Buffer.from(expected).copy(b);
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_password" });
  res.cookie("admin_session", makeAdminToken(), {
    httpOnly: true, secure: true, sameSite: "strict",
    maxAge: ADMIN_SESSION_TTL_SECONDS * 1000, path: "/",
  });
  res.json({ ok: true });
});

app.get("/api/admin/history", requireAdmin, async (_req, res) => {
  try {
    const [queriesRes, creditsRes] = await Promise.all([
      supabaseService
        .from("vin_queries")
        .select("id, user_id, vin, type, success, created_at, vehicle")
        .order("created_at", { ascending: false })
        .limit(1000),
      supabaseService
        .from("credits")
        .select("user_id, email, balance, stripe_subscription_id, updated_at")
        .order("updated_at", { ascending: false })
        .limit(200),
    ]);

    res.json({
      ok:    true,
      rows:  queriesRes.data  || [],
      users: creditsRes.data  || [],
    });
  } catch (e) {
    console.error("Admin history error:", e.message);
    res.status(500).json({ ok: false });
  }
});

// Owner dashboard (in the signed-in user's own Dashboard page) — gated by the
// VERIFIED Supabase token = CFC_OWNER_EMAIL (requireOwnerMw), so it's for the
// owner alone, not the shared admin password. Covers BOTH sites (shared DB).
app.get("/api/owner/users", requireOwnerMw, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim() || null;
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 1000);
    const [usersR, statsR] = await Promise.all([
      supabaseService.rpc("admin_list_users", { p_search: search, p_limit: limit, p_offset: 0 }),
      supabaseService.rpc("admin_site_stats", { p_days: 30 }),
    ]);
    if (usersR.error) throw usersR.error;
    res.json({ ok: true, users: usersR.data || [], stats: statsR.data || null });
  } catch (e) {
    console.error("Owner users error:", e.message);
    res.status(500).json({ ok: false, error: "users_failed" });
  }
});

// admin.html calls these on load / logout — they must exist or the page
// treats every visit as signed-out (and the cookie never clears).
app.get("/api/admin/whoami", (req, res) => {
  res.json({ admin: verifyAdminToken(req.cookies?.admin_session || "") });
});

app.post("/api/admin/logout", (_req, res) => {
  res.clearCookie("admin_session", { httpOnly: true, secure: true, sameSite: "strict", path: "/" });
  res.json({ ok: true });
});

// Users & subscriptions dashboard — every account across BOTH sites (shared
// Supabase), with balance, subscription, report count, and activity times.
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim() || null;
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
    const { data, error } = await supabaseService.rpc("admin_list_users", {
      p_search: search, p_limit: limit, p_offset: 0,
    });
    if (error) throw error;
    res.json({ ok: true, users: data || [] });
  } catch (e) {
    console.error("Admin users error:", e.message);
    res.status(500).json({ ok: false, error: "users_failed" });
  }
});

app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

/* ================================================================
   Dashboard Stats — single endpoint for the user dashboard
================================================================ */
app.get("/api/dashboard", async (req, res) => {
  try {
    const { user } = await getUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const { data: credRow } = await supabaseService
      .from("credits")
      .select("balance, stripe_subscription_id")
      .eq("user_id", user.id)
      .maybeSingle();

    const { data: queries } = await supabaseService
      .from("vin_queries")
      .select("vin, type, success, created_at, vehicle")
      .eq("user_id", user.id)
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(500);

    const rows = queries || [];

    // Monthly breakdown — last 6 months
    const now = new Date();
    const monthly = {};
    for (let i = 5; i >= 0; i--) {
      const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      monthly[key] = 0;
    }
    for (const r of rows) {
      const d   = new Date(r.created_at);
      const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      if (key in monthly) monthly[key]++;
    }

    const thisMonthKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    const thisMonth    = monthly[thisMonthKey] || 0;

    // Top checked VINs
    const vinCount = {};
    for (const r of rows) { vinCount[r.vin] = (vinCount[r.vin] || 0) + 1; }
    const topVins = Object.entries(vinCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([vin, count]) => ({ vin, count }));

    // Subscription plan label
    let plan = "None";
    if (credRow && credRow.stripe_subscription_id) {
      try {
        const sub     = await stripeDefault.subscriptions.retrieve(credRow.stripe_subscription_id);
        const priceId = sub.items && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
        if      (priceId === SUB_STARTER)  plan = "Starter";
        else if (priceId === SUB_PRO)      plan = "Pro";
        else if (priceId === SUB_PREMIUM)  plan = "Premium";
        else                               plan = "Active";
      } catch { plan = "Active"; }
    }

    res.json({
      ok: true,
      balance:       (credRow ? credRow.balance : 0) + (await getSubCreditBalance(user.id)),
      plan,
      totalReports:  rows.length,
      thisMonth,
      monthly,
      topVins,
      recentReports: rows.slice(0, 10),
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================================================================
   Direct PDF Download
   Calls CFC /report/pdf directly and streams it to the browser.
   Falls back to print-dialog HTML if CFC has no PDF.
================================================================ */
app.get("/api/download-pdf", async (req, res) => {
  try {
    const { user } = await getUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const vin = (req.query.vin || "").toUpperCase().trim();
    if (!vin || vin.length !== 17) {
      return res.status(400).json({ error: "valid VIN required" });
    }

    // Verify the user has run this report before (owns it)
    const { data: owned } = await supabaseService
      .from("vin_queries")
      .select("id")
      .eq("user_id", user.id)
      .eq("vin", vin)
      .eq("success", true)
      .maybeSingle();

    if (!owned) {
      return res.status(403).json({ error: "report_not_owned" });
    }

    // No PDF endpoint — serve HTML with print dialog
    console.log(`[PDF] Serving print-dialog HTML for ${vin}`);
    const raw = await getReportData(vin, "carfax");
    if (!raw) return res.status(404).json({ error: "report_not_cached" });

    const decoded = decodeReportBase64(raw);
    if (decoded.kind !== "html") return res.status(404).json({ error: "no_html" });

    // Inject auto-print and a banner telling user to Save as PDF
    const banner = [
      "<div style='position:fixed;top:0;left:0;right:0;background:#1e3a8a;color:white;",
      "padding:10px 16px;font-family:sans-serif;font-size:13px;font-weight:600;",
      "display:flex;align-items:center;justify-content:space-between;z-index:99999;'>",
      "<span>📄 To save as PDF: press <kbd style='background:#3b82f6;padding:2px 8px;border-radius:4px;'>Ctrl+P</kbd>",
      " (Windows) or <kbd style='background:#3b82f6;padding:2px 8px;border-radius:4px;'>Cmd+P</kbd>",
      " (Mac) then choose <strong>Save as PDF</strong></span>",
      "<button onclick='window.print()' style='background:#3b82f6;border:none;color:white;",
      "padding:6px 14px;border-radius:6px;cursor:pointer;font-weight:bold;'>Print / Save PDF</button>",
      "</div>",
      "<div style='height:44px;'></div>",
    ].join("");

    const printScript = "<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},800);});<\/script>";
    const finalHtml   = injectReportChrome(decoded.html)
      .replace("<body", `<body style='padding-top:0;'`)
      .replace(/<body[^>]*>/, (m) => m + banner)
      .replace("</body>", printScript + "</body>");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(finalHtml);

  } catch (err) {
    console.error("[PDF] Error:", err.message);
    return res.status(500).json({ error: "pdf_failed", message: err.message });
  }
});

/* ================================================================
   Is Owner — lightweight check, returns true only for CFC_OWNER_EMAIL
================================================================ */
app.get("/api/is-owner", async (req, res) => {
  try {
    const { user } = await getUser(req);
    if (!user) return res.json({ owner: false });
    const isOwner = CFC_OWNER_EMAIL && user.email === CFC_OWNER_EMAIL;
    res.json({ owner: !!isOwner });
  } catch {
    res.json({ owner: false });
  }
});

/* ================================================================
   CFC Owner Dashboard — only accessible to CFC_OWNER_EMAIL
================================================================ */
app.get("/api/cfc-dashboard", async (req, res) => {
  try {
    const { user } = await getUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    if (CFC_OWNER_EMAIL && user.email !== CFC_OWNER_EMAIL) {
      return res.status(403).json({ error: "forbidden" });
    }

    // Credits: pull live limits from CheapCARFAX + local counter for CFC
    const [ccfLimits, cfcCredits] = await Promise.all([getCfcApiLimits(), getCfcCredits()]);
    const credits = ccfLimits !== null ? ccfLimits.credits : cfcCredits;
    const ccfDailyLeft = ccfLimits?.carfax_reports_left_today ?? null;
    const ccfDailyLimit = ccfLimits?.daily_limit ?? (process.env.CCF_DAILY_HARD_LIMIT ? Number(process.env.CCF_DAILY_HARD_LIMIT) : null);

    // All-time report stats
    const { data: allReports } = await supabaseService
      .from("vin_queries")
      .select("vin, type, success, created_at, user_id, vehicle")
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(1000);

    const rows = allReports || [];

    // Monthly breakdown last 6 months
    const now = new Date();
    const monthly = {};
    for (let i = 5; i >= 0; i--) {
      const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      monthly[key] = 0;
    }
    for (const r of rows) {
      const d   = new Date(r.created_at);
      const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      if (key in monthly) monthly[key]++;
    }

    const thisMonthKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");

    res.json({
      ok: true,
      credits_remaining:  credits,
      ccf_daily_left:     ccfDailyLeft,
      ccf_daily_limit:    ccfDailyLimit,
      total_reports:      rows.length,
      this_month:         monthly[thisMonthKey] || 0,
      monthly,
      recent:             rows.slice(0, 20),
    });
  } catch (err) {
    console.error("CFC dashboard error:", err.message);
    res.status(500).json({ error: "server_error" });
  }
});

/* ================================================================
   Owner admin AI — when the authenticated OWNER uses the chat widget,
   the assistant switches to an admin persona with read-only DB tools
   (backed by the admin_* RPCs in the shared Supabase, so it covers
   BOTH autovinreveal.com and cheapestcarfax.com customers).
================================================================ */
function buildChatTurns(history, message, image) {
  // De-dupe: the client pushes the latest user turn into `history` AND sends it
  // as `message`; drop a trailing user turn equal to message to avoid a double turn.
  const cleaned = (history || []).slice(-8).map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || ""),
  }));
  while (cleaned.length && cleaned[cleaned.length - 1].role === "user" && cleaned[cleaned.length - 1].content === message) {
    cleaned.pop();
  }
  let lastUserContent = message;
  if (image && typeof image === "string") {
    const m = image.match(/^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (m && m[2].length < 7_000_000) {
      lastUserContent = [
        { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
        { type: "text", text: message || "Here's a screenshot — can you help with this?" },
      ];
    }
  }
  return { cleaned, lastUserContent };
}

const OWNER_ADMIN_TOOLS = [
  {
    name: "lookup_user",
    description: "Look up ONE customer by exact email (case-insensitive). Returns account info (created, last sign-in, email confirmed), credit balance, Stripe customer/subscription ids, delivered/failed report counts, the 10 most recent reports, recent credit-ledger entries (positive delta = credits added, negative = used), and recent purchases. Call this whenever the owner asks about a specific customer.",
    input_schema: { type: "object", properties: { email: { type: "string", description: "The customer's email address" } }, required: ["email"] },
  },
  {
    name: "list_users",
    description: "List users newest-first, optionally filtered by partial email. Per user: email, created_at, last_sign_in_at, credit balance, stripe_subscription_id, delivered report count, last report time. Use for questions like 'who signed up this week', 'find the user with gmail …', 'who still has credits'.",
    input_schema: { type: "object", properties: { search: { type: "string", description: "Partial email filter (optional)" }, limit: { type: "integer", description: "Max rows, default 50, max 200" } }, required: [] },
  },
  {
    name: "site_stats",
    description: "Business stats for the last N days across the shared backend (covers BOTH sites): total/new users, reports delivered/failed, active report users, credits granted/spent, outstanding credit balance, active Stripe subscriptions, fulfilled Whop purchases by site, open chats by site.",
    input_schema: { type: "object", properties: { days: { type: "integer", description: "Window in days, default 7, max 365" } }, required: [] },
  },
  {
    name: "recent_reports",
    description: "Most recent report runs across ALL users: VIN, type, vehicle, success, time, and the user's email (or 'guest'). Use for 'what ran today' or 'any failures lately'.",
    input_schema: { type: "object", properties: { limit: { type: "integer", description: "Max rows, default 20, max 100" }, only_failures: { type: "boolean", description: "true = only failed runs" } }, required: [] },
  },
];

async function execOwnerAdminTool(name, input) {
  if (name === "lookup_user") {
    const { data, error } = await supabaseService.rpc("admin_user_detail", { p_email: String(input?.email || "").trim() });
    if (error) throw new Error(error.message);
    return data ? JSON.stringify(data) : "No user found with that email. Try list_users with a partial search.";
  }
  if (name === "list_users") {
    const { data, error } = await supabaseService.rpc("admin_list_users", {
      p_search: String(input?.search || "").trim() || null,
      p_limit: Math.min(Math.max(parseInt(input?.limit, 10) || 50, 1), 200),
      p_offset: 0,
    });
    if (error) throw new Error(error.message);
    return JSON.stringify(data || []);
  }
  if (name === "site_stats") {
    const { data, error } = await supabaseService.rpc("admin_site_stats", {
      p_days: Math.min(Math.max(parseInt(input?.days, 10) || 7, 1), 365),
    });
    if (error) throw new Error(error.message);
    return JSON.stringify(data);
  }
  if (name === "recent_reports") {
    const limit = Math.min(Math.max(parseInt(input?.limit, 10) || 20, 1), 100);
    let q = supabaseService.from("vin_queries")
      .select("vin, type, vehicle, success, created_at, user_id")
      .order("created_at", { ascending: false }).limit(limit);
    if (input?.only_failures) q = q.eq("success", false);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = data || [];
    const ids = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
    const emails = {};
    if (ids.length) {
      const { data: em } = await supabaseService.from("credits").select("user_id, email").in("user_id", ids);
      for (const e of (em || [])) emails[e.user_id] = e.email;
    }
    return JSON.stringify(rows.map(r => ({
      vin: r.vin, type: r.type, vehicle: r.vehicle, success: r.success, at: r.created_at,
      user: r.user_id ? (emails[r.user_id] || r.user_id) : "guest",
    })));
  }
  return "Unknown tool: " + name;
}

// Tool-use loop against the Messages API (same raw-HTTP style as the visitor chat).
async function runOwnerAdminChat({ apiKey, history, message, image }) {
  const sys = `You are the private ADMIN assistant for the owner of AutoVINReveal (autovinreveal.com) and CheapestCarFax (cheapestcarfax.com). Both sites share ONE backend, so your tools cover users, credits, reports, and purchases of BOTH sites.

You are talking to the OWNER — their identity was verified by server-side login, so answer freely about any customer or business data. Always use the tools instead of guessing; if one lookup comes back empty, try list_users with a partial search before giving up.

STYLE: plain text only, no markdown or bullets. Be concise but give real numbers, emails, and dates (like "Jun 28, 2026"). Short multi-line summaries are fine. If asked something that needs no data (or general support questions), just answer normally.`;
  const { cleaned, lastUserContent } = buildChatTurns(history, message, image);
  const messages = [...cleaned, { role: "user", content: lastUserContent }];

  let reply = "";
  for (let turn = 0; turn < 6; turn++) {
    const r = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-opus-4-8",
        max_tokens: 1500,
        system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }],
        tools: OWNER_ADMIN_TOOLS,
        messages,
      },
      { headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, timeout: 60000 }
    );
    const data = r.data || {};
    const blocks = data.content || [];
    const text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const toolUses = blocks.filter(b => b.type === "tool_use");
    if (data.stop_reason !== "tool_use" || !toolUses.length) { reply = text || reply; break; }

    messages.push({ role: "assistant", content: blocks });
    const results = [];
    for (const tu of toolUses) {
      let out, isErr = false;
      try { out = await execOwnerAdminTool(tu.name, tu.input || {}); }
      catch (e) { out = "Tool error: " + e.message; isErr = true; }
      console.log(`[AdminChat] tool ${tu.name} → ${isErr ? "ERROR" : String(out).length + " chars"}`);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: String(out).slice(0, 30000), ...(isErr ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return reply || "Sorry, I couldn't complete that lookup — try rephrasing.";
}

/* ================================================================
   AI Chat Widget
================================================================ */
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [], userEmail = null, conversation_id: convoIdRaw = null, image = null } = req.body || {};
    if (!message && !image) return res.status(400).json({ error: "message required" });

    // ── Conversation persistence (enables live owner takeover) ──
    let conversationId = convoIdRaw;
    let convoMode = "ai";
    try {
      if (conversationId) {
        const { data: c } = await supabaseService
          .from("chat_conversations").select("id, mode").eq("id", conversationId).eq("site", SITE_ID).maybeSingle();
        if (c) convoMode = c.mode || "ai";
        else conversationId = null; // unknown id — start fresh
      }
      if (!conversationId) {
        const { data: c } = await supabaseService
          .from("chat_conversations").insert({ site: SITE_ID, visitor_email: userEmail || null }).select("id").single();
        conversationId = c?.id || null;
      }
      if (conversationId) {
        await supabaseService.from("chat_messages").insert({ conversation_id: conversationId, role: "user", content: String(message).slice(0, 4000), image: (image && typeof image === "string" && image.length < 2_000_000) ? image : null });
        await supabaseService.from("chat_conversations")
          .update({ last_message_at: new Date().toISOString(), ...(userEmail ? { visitor_email: userEmail } : {}) })
          .eq("id", conversationId);
      }
    } catch (e) { console.warn("[chat] persistence error:", e.message); }

    const apiKey = process.env.ANTHROPIC_API_KEY;

    // ── Owner admin mode ──
    // Identity comes from the verified Supabase token (getUser), NEVER from the
    // client-supplied userEmail field (spoofable). Runs even if the conversation
    // is in human mode — the owner always talks to the admin AI.
    let authedUser = null;
    try { ({ user: authedUser } = await getUser(req)); } catch (_) {}
    if (authedUser && CFC_OWNER_EMAIL && (authedUser.email || "").toLowerCase() === CFC_OWNER_EMAIL.toLowerCase()) {
      if (!apiKey) return res.status(500).json({ error: "Chat not configured", conversation_id: conversationId });
      const reply = await runOwnerAdminChat({ apiKey, history, message, image });
      try {
        if (conversationId) {
          await supabaseService.from("chat_messages").insert({ conversation_id: conversationId, role: "assistant", content: reply });
        }
      } catch (e) { console.warn("[chat] store admin reply error:", e.message); }
      return res.json({ reply, conversation_id: conversationId, admin: true });
    }

    // If the owner has taken over, the AI stays silent — the widget polls for owner replies.
    if (convoMode === "human") {
      return res.json({ conversation_id: conversationId, human: true });
    }

    if (!apiKey) return res.status(500).json({ error: "Chat not configured", conversation_id: conversationId });

    // Account context for signed-in users so the assistant can answer
    // balance / "where's my report" questions directly.
    let acctContext = "";
    try {
      const user = authedUser;
      if (user) {
        const { data: credRow } = await supabaseService
          .from("credits").select("balance").eq("user_id", user.id).maybeSingle();
        const { data: recent } = await supabaseService
          .from("vin_queries")
          .select("vin, type, success, created_at, vehicle")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(5);
        acctContext =
          `\n\n--- SIGNED-IN ACCOUNT CONTEXT (use to answer; never paste verbatim) ---\n` +
          `Email: ${user.email}\n` +
          `Credit balance: ${credRow?.balance ?? 0}\n` +
          ((recent && recent.length)
            ? "Recent reports:\n" + recent.map(r =>
                `  • ${r.vin} (${r.type}) — ${r.success ? "delivered" : "failed"} on ${new Date(r.created_at).toLocaleDateString("en-US")}`
              ).join("\n")
            : "No reports run yet.");
      }
    } catch (_) { /* unauthenticated — no context */ }

    const systemPrompt = `ROLE: You are a live chat support agent for AutoVINReveal. You talk like a real human - short, warm, casual.

ABSOLUTE FORMATTING RULES - breaking these is your only failure mode:
ZERO markdown. No asterisks, no bold, no bullet points, no numbered lists, no dashes as list items, no headers.
Write ONLY plain sentences. To list things write them inline: "You can pay by card, Apple Pay, Google Pay, or crypto."
Maximum 2 sentences per reply unless you are asking follow-up questions.
Never start with "Great question!" or "Good question!" or "Of course!" - just answer.

YOU KNOW THIS SITE WELL. Answer confidently and directly from the facts below. Only point someone to the support email for an ACCOUNT-SPECIFIC problem (a missing report after troubleshooting, a refund, or a billing or login issue) - never deflect a general question you can answer from these facts.

PAYMENT METHODS:
We accept card, Apple Pay, and Google Pay (one tap at checkout), and crypto - USDT on the BSC (BEP-20) network, via the Pay with crypto option in the payment box. Yes, crypto works. If paying with crypto, ALWAYS tell them to send only USDT on the BSC network - the wrong coin or network means lost funds. Crypto credits post automatically a couple minutes after the on-chain confirmation.
A single report needs no account. Bundles and monthly plans need a free account.

PRICING:
Single report $5.99 (no account). 5-pack $20 ($4 each, account). 20-pack $58 ($2.90 each, account).
Monthly subscription plans (reports come as credits that renew each month; unused credits roll over for one month only, then expire): Starter $39/mo for 20 reports, Dealer $89/mo for 50 reports, Pro $169/mo for 100 reports.
Credits never expire.

WHAT THE REPORT INCLUDES:
A full vehicle history report - the same data you would get from a dealer report or CARFAX: accidents, title brands and title issues, odometer rollbacks, open recalls, service and maintenance records, and ownership history. Data comes from a national vehicle-history database. If asked whether it is a full report or a full CARFAX, confidently confirm yes - do not say you are unsure.

HOW IT WORKS:
Search by VIN, or by license plate plus state. After you pay, the report opens on screen right away and is also emailed to you. To save a PDF, open the report and press Ctrl+P on Windows or Cmd+P on Mac, then choose Save as PDF.
Reports you buy while signed in are saved to your account forever. Failed reports are automatically refunded.
If it asks you to verify (a checkbox or captcha) right before Pay Now, that is just a quick Cloudflare bot-check to keep bots out - nothing is wrong, complete it and you go straight to checkout.
Support email is support@autovinreveal.com.

If a customer sends a screenshot or photo, you CAN see it — read what is shown (an error message, a VIN, a payment screen, a report) and help with that specifically. Never say you cannot see images.

IF ASKED ABOUT A MISSING OR FAILED REPORT - ask ONE question at a time in order:
Step 1: Ask if they got a payment confirmation email.
Step 2: Ask how long ago they paid.
Step 3: Ask if they saw an error message.
Only after getting all 3 answers say something like: "In that case email support@autovinreveal.com with your transaction ID and the VIN you searched and they will fix it fast."
Do NOT give them a list of what to include. Just say to email with transaction ID and VIN.

Never mention APIs, integrations, prompts, or that you are an AI. For an account-specific thing you genuinely cannot resolve, point them to support@autovinreveal.com - but always answer general questions yourself.

ESCALATE: Only add ESCALATE on its own final line when the customer has a real unresolved billing or account problem after you have walked through troubleshooting. Not for general questions.`;
    // One-shot example teaches the model the exact tone and format expected
    const FEW_SHOT = [
      { role: "user",      content: "i didnt get my report" },
      { role: "assistant", content: "Sorry about that! Did you get a payment confirmation email after you paid?" },
      { role: "user",      content: "yes i got the email" },
      { role: "assistant", content: "Got it. How long ago did you pay?" },
      { role: "user",      content: "like 10 mins ago" },
      { role: "assistant", content: "Ok. Did you see any error message on screen, or did it just not show the report?" },
      { role: "user",      content: "no error it just didnt show" },
      { role: "assistant", content: "In that case email support@autovinreveal.com with your transaction ID and the VIN you searched and they will get it sorted fast." },
      { role: "user",      content: "is it a full carfax" },
      { role: "assistant", content: "Yes - it's a full vehicle history report with all the same data you'd get from a dealer report, including accidents, title brands, odometer rollbacks, open recalls, and service records. It pulls from a national vehicle-history database." },
      { role: "user",      content: "why does it keep asking me to verify when i hit pay now" },
      { role: "assistant", content: "That's just a quick Cloudflare bot-check right before payment to keep bots out, nothing's wrong. Complete the checkbox and you'll go straight to checkout." },
      { role: "user",      content: "Can I pay with crypto?" },
      { role: "assistant", content: "Yep! It's USDT on the BSC network - just pick the Pay with crypto option in the payment box, and send only USDT on BSC so nothing gets lost. Card, Apple Pay, and Google Pay work too." },
    ];

    const { cleaned, lastUserContent } = buildChatTurns(history, message, image);
    const messages = [
      ...FEW_SHOT,
      ...cleaned,
      { role: "user", content: lastUserContent },
    ];

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: [
          { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
          ...(acctContext ? [{ type: "text", text: acctContext }] : []),
        ],
        messages,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        timeout: 20000,
      }
    );

    let reply = response.data?.content?.[0]?.text || "Sorry, I could not process that.";

    // Check if AI wants to escalate to human
    const shouldEscalate = reply.includes("ESCALATE");
    reply = reply.replace(/\nESCALATE\s*$/m, "").replace(/ESCALATE\s*$/m, "").trim();

    // Notify the owner whenever the bot escalates OR tells a visitor to email support,
    // so you can review the conversation. (Once per conversation to avoid repeats.)
    const mentionsSupport = /email\s+support|support@(?:autovinreveal|cheapestcarfax)\.com/i.test(reply);
    const shouldNotify = shouldEscalate || mentionsSupport;

    let alreadyFlagged = false;
    try {
      if (conversationId) {
        await supabaseService.from("chat_messages").insert({ conversation_id: conversationId, role: "assistant", content: reply });
        if (shouldNotify) {
          const { data: cf } = await supabaseService.from("chat_conversations").select("flagged").eq("id", conversationId).maybeSingle();
          alreadyFlagged = !!(cf && cf.flagged);
          if (!alreadyFlagged) await supabaseService.from("chat_conversations").update({ flagged: true }).eq("id", conversationId);
        }
      }
    } catch (e) { console.warn("[chat] store reply error:", e.message); }

    if (shouldNotify && !alreadyFlagged && mailer) {
      const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const convoLines = [
        ...history.map(m => (m.role === "user" ? "User: " : "Bot: ") + m.content),
        "User: " + message,
        "Bot: " + reply,
      ];
      const convoHtml = convoLines
        .map(l => `<p style="margin:4px 0;${l.startsWith("User:") ? "color:#1e3a8a;font-weight:bold;" : "color:#475569;"}">${esc(l)}</p>`)
        .join("");
      const reason = shouldEscalate ? "escalated to a human" : "told a visitor to email support";

      mailer.sendMail({
        from: SMTP_FROM,
        to: CFC_OWNER_EMAIL || SMTP_USER,
        subject: `AutoVINReveal chat — bot ${shouldEscalate ? "needs you" : "sent someone to support"}${userEmail ? " · " + userEmail : ""}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1e3a8a;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
            <strong>The bot ${reason}</strong>${userEmail ? " &mdash; " + esc(userEmail) : ""}
          </div>
          <div style="border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 8px 8px;background:#f8fafc;">
            <p style="color:#64748b;font-size:13px;margin-bottom:12px;">Full conversation:</p>
            ${convoHtml}
            <hr style="margin:16px 0;border:none;border-top:1px solid #e2e8f0;"/>
            <p style="color:#64748b;font-size:12px;">${userEmail ? `Reply to the visitor: <a href="mailto:${esc(userEmail)}">${esc(userEmail)}</a>` : "Visitor was not signed in (no email captured)."}</p>
          </div>
        </div>`,
      }).catch(e => console.error("[Chat notify email failed]", e.message));
    }

    res.json({ reply, escalated: shouldEscalate, conversation_id: conversationId });
  } catch (err) {
    console.error("Chat error:", err.response?.data || err.message);
    res.status(500).json({ error: "Chat failed" });
  }
});

/* ================================================================
   Live chat takeover — visitor polling + owner inbox
================================================================ */
// Owner-only gate (Supabase token, must be CFC_OWNER_EMAIL).
async function requireOwnerMw(req, res, next) {
  try {
    const { user } = await getUser(req);
    if (user && CFC_OWNER_EMAIL && (user.email || "").toLowerCase() === CFC_OWNER_EMAIL.toLowerCase()) return next();
  } catch (_) {}
  return res.status(403).json({ error: "forbidden" });
}

// Visitor polls for new owner/assistant messages and the current mode.
app.get("/api/chat/poll", async (req, res) => {
  try {
    const conversationId = req.query.conversation_id;
    const after = Number(req.query.after || 0) || 0;
    if (!conversationId) return res.json({ mode: "ai", messages: [] });
    const { data: convo } = await supabaseService
      .from("chat_conversations").select("mode").eq("id", conversationId).eq("site", SITE_ID).maybeSingle();
    const { data: msgs } = await supabaseService
      .from("chat_messages").select("id, role, content, created_at, image")
      .eq("conversation_id", conversationId).gt("id", after)
      .order("id", { ascending: true }).limit(50);
    res.json({ mode: convo?.mode || "ai", messages: msgs || [] });
  } catch { res.json({ mode: "ai", messages: [] }); }
});

// Owner inbox (admin cookie required).
app.get("/api/admin/chats", requireOwnerMw, async (_req, res) => {
  try {
    const { data } = await supabaseService
      .from("chat_conversations")
      .select("id, visitor_email, mode, flagged, status, last_message_at, owner_read_at")
      .eq("site", SITE_ID).eq("status", "open")
      .order("last_message_at", { ascending: false }).limit(100);
    res.json({ conversations: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/chats/:id", requireOwnerMw, async (req, res) => {
  try {
    const { data: convo } = await supabaseService
      .from("chat_conversations").select("*").eq("id", req.params.id).eq("site", SITE_ID).maybeSingle();
    if (!convo) return res.status(404).json({ error: "not_found" });
    const { data: msgs } = await supabaseService
      .from("chat_messages").select("id, role, content, created_at, image")
      .eq("conversation_id", req.params.id).order("id", { ascending: true }).limit(500);
    // Mark read for the owner so the inbox can flag conversations with newer messages.
    await supabaseService.from("chat_conversations")
      .update({ owner_read_at: new Date().toISOString() })
      .eq("id", req.params.id).eq("site", SITE_ID);
    res.json({ conversation: convo, messages: msgs || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/chats/:id/reply", requireOwnerMw, async (req, res) => {
  try {
    const content = String(req.body?.content || "").trim();
    // Optional image attachment — same data-URL format + 2MB cap as visitor uploads.
    const image = (typeof req.body?.image === "string"
      && /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(req.body.image)
      && req.body.image.length < 2_000_000) ? req.body.image : null;
    if (!content && !image) return res.status(400).json({ error: "empty" });
    await supabaseService.from("chat_messages")
      .insert({ conversation_id: req.params.id, role: "owner", content: content.slice(0, 4000), image });
    await supabaseService.from("chat_conversations")
      .update({ mode: "human", flagged: false, last_message_at: new Date().toISOString() })
      .eq("id", req.params.id).eq("site", SITE_ID);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Take over (mode=human) or hand back to the AI (mode=ai).
app.post("/api/admin/chats/:id/mode", requireOwnerMw, async (req, res) => {
  try {
    const mode = req.body?.mode === "human" ? "human" : "ai";
    await supabaseService.from("chat_conversations")
      .update({ mode, ...(mode === "ai" ? { flagged: false } : {}) })
      .eq("id", req.params.id).eq("site", SITE_ID);
    res.json({ ok: true, mode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ================================================================
   Chat Escalation — sends conversation to owner when AI can't help
================================================================ */
app.post("/api/chat-escalate", async (req, res) => {
  try {
    const { email, convo = [] } = req.body || {};
    if (!mailer) return res.status(500).json({ error: "email_not_configured" });

    const convoHtml = convo.map(function(m) {
      const isUser = m.role === "user";
      const style  = isUser ? "color:#1e3a8a;font-weight:bold;" : "color:#475569;";
      const prefix = isUser ? "Customer: " : "Bot: ";
      const text   = String(m.content || "").replace(/</g, "&lt;");
      return "<p style='margin:4px 0;" + style + "'>" + prefix + text + "</p>";
    }).join("");

    const emailHeader = email
      ? " &mdash; <a href='mailto:" + email + "' style='color:#93c5fd;'>" + email + "</a>"
      : " (no email provided)";

    const noMessages = "<p style='color:#94a3b8;'>No messages recorded.</p>";

    const html = [
      "<div style='font-family:sans-serif;max-width:600px;margin:0 auto;'>",
      "  <div style='background:#1e3a8a;color:white;padding:16px 20px;border-radius:8px 8px 0 0;'>",
      "    <strong>Customer needs human support</strong>" + emailHeader,
      "  </div>",
      "  <div style='border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 8px 8px;background:#f8fafc;'>",
      "    <p style='color:#64748b;font-size:13px;margin-bottom:12px;'>Conversation history:</p>",
      "    " + (convoHtml || noMessages),
      "    <hr style='margin:16px 0;border:none;border-top:1px solid #e2e8f0;'/>",
      "    <p style='color:#64748b;font-size:12px;'>Hit <strong>Reply</strong> to respond directly to the customer.</p>",
      "  </div>",
      "</div>",
    ].join("\n");

    await mailer.sendMail({
      from:    SMTP_FROM,
      to:      SMTP_USER,
      replyTo: email || SMTP_USER,
      subject: "AutoVINReveal: Customer needs help" + (email ? " — " + email : ""),
      html,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Chat escalate error:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

/* ================================================================
   Plate Lookup — converts license plate + state to VIN
   Uses Reports.VIN /v1/checkplate/:state/:plate
================================================================ */
app.get("/api/plate-lookup/:state/:plate", lookupLimiter, async (req, res) => {
  try {
    const state = (req.params.state || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
    const plate = (req.params.plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    if (!state || !plate) return res.status(400).json({ error: "state and plate required" });

    const key = process.env.REPORTSVIN_API_KEY;
    if (!key) return res.status(500).json({ error: "provider_not_configured" });

    const r = await axios.get(`${CCF_BASE}/checkplate/${state}/${plate}`, {
      headers: { "API-KEY": key },
      timeout: 15000,
      validateStatus: () => true,
    });

    console.log(`[PlateLookup] ${state}/${plate} → ${r.status}`);
    if (r.status === 404 || !r.data) return res.status(404).json({ error: "plate_not_found", message: "No vehicle found for that plate." });
    if (r.status === 401)            return res.status(500).json({ error: "auth_error" });
    if (r.status >= 400)             return res.status(502).json({ error: "lookup_failed", message: r.data?.message || "Lookup failed." });

    const vin = r.data?.vin || r.data?.VIN || r.data?.data?.vin || null;
    if (!vin) return res.status(404).json({ error: "vin_not_found", message: "Plate found but no VIN returned." });

    res.json({ ok: true, vin, raw: r.data });
  } catch (err) {
    console.error("[PlateLookup] Error:", err.message);
    res.status(500).json({ error: "plate_lookup_failed", message: err.message });
  }
});

/* ================================================================
   VIN Record Summary — quick preview (no full report fetch)
   Used to show accident count / title status before user pays
   Uses Reports.VIN /v1/checkrecords/:vin
================================================================ */
app.get("/api/vin-summary/:vin", lookupLimiter, async (req, res) => {
  try {
    const vin = (req.params.vin || "").toUpperCase().trim();
    const v = validateVin(vin);
    if (!v.ok) return res.status(422).json({ error: "invalid_vin", message: v.msg });

    const key = process.env.REPORTSVIN_API_KEY;
    if (!key) return res.status(500).json({ error: "provider_not_configured" });

    const r = await axios.get(`${CCF_BASE}/checkrecords/${vin}`, {
      headers: { "API-KEY": key },
      timeout: 15000,
      validateStatus: () => true,
    });

    console.log(`[VINSummary] ${vin} → ${r.status}`);
    if (r.status === 404) return res.status(404).json({ error: "vin_not_found" });
    if (r.status === 401) return res.status(500).json({ error: "auth_error" });
    if (r.status >= 400)  return res.status(502).json({ error: "summary_failed" });

    res.json({ ok: true, vin, summary: r.data });
  } catch (err) {
    console.error("[VINSummary] Error:", err.message);
    res.status(500).json({ error: "summary_failed", message: err.message });
  }
});

/* ================================================================
   Static Files & Boot
================================================================ */
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    // Never serve stale HTML — keeps old button text/copy from lingering in browsers
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store, must-revalidate");
  },
}));
app.get("/301", (_req, res) => res.redirect(301, "/"));
app.get("*", (req, res) => {
  if (req.accepts("html")) {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "index.html"));
  } else res.status(404).send("Not found");
});

app.listen(Number(PORT), HOST, () => {
  console.log(`\n🚀 Server is running!`);
  console.log(`-------------------------------------------`);
  console.log(`➡️  Local:   http://localhost:${PORT}`);
  console.log(`➡️  Network: http://127.0.0.1:${PORT}`);
  console.log(`-------------------------------------------\n`);
});