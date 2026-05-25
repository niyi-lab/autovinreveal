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
 * FIXES IN THIS VERSION:
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
const SITE_URL       = process.env.SITE_URL      || `http://localhost:${PORT}`;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || SITE_URL;
const FORCE_WWW      = process.env.FORCE_WWW === "1";

const APP_SECRET     = process.env.APP_SECRET    || "change_me_in_env_file";
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

// TEMP — find outbound IP, delete after getting it
app.get("/api/myip", async (_req, res) => {
  try {
    const r = await axios.get("https://api.ipify.org?format=json", { timeout: 5000 });
    res.json(r.data);
  } catch (e) {
    res.json({ error: e.message });
  }
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
   PayPal package config
================================================================ */
const PAYPAL_PACKAGE_CONFIG = {
  single:   { amount: "6.00",  credits: 1  },
  "5pack":  { amount: "20.00", credits: 5  },
  "20pack": { amount: "58.00", credits: 20 },
};
function resolvePaypalPackage(pkg) {
  if (pkg === "10pack") return PAYPAL_PACKAGE_CONFIG["20pack"]; // legacy alias
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
    .then(() => console.log("✅ SMTP mailer ready"))
    .catch(e  => console.error("❌ SMTP failed:", e));
} else {
  console.warn("⚠️  SMTP not configured. Emails will fail.");
}

/* ================================================================
   CarfaxCheaper removed — CheapCARFAX is the sole provider
================================================================ */
const CFC_OWNER_EMAIL = process.env.CFC_OWNER_EMAIL || "";
const CFC_CREDITS_KEY = "cfc_credits_remaining";


/* ================================================================
   Smart Provider Switching
   Active provider: CheapCARFAX (CCF) only.
   Auto-switches on daily limit, auth error, 3+ failures (5min cooldown)
================================================================ */

// CheapCARFAX (panel.cheapcarfax.net) — sole provider
const CCF_BASE = "https://panel.cheapcarfax.net/api";

const providerState = {
  cfc: { failures: 0, lastFailure: null },
};
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown after 3 failures

function cfcAvailable() {
  if (!process.env.CHEAPCARFAX_API_KEY) return false;
  const s = providerState.cfc;
  if (s.failures >= 3 && s.lastFailure && (Date.now() - s.lastFailure) < COOLDOWN_MS) {
    console.log(`[Provider] CheapCARFAX in cooldown after ${s.failures} failures`);
    return false;
  }
  return true;
}

// Main report fetch entry point — type: "carfax" | "autocheck"
async function cfcGetReport(vin, type = "carfax") {
  try {
    const result = await fetchFromCfc(vin, type);
    providerState.cfc.failures = 0;
    console.log(`[Provider] ✓ CheapCARFAX ${type} — VIN: ${vin}`);
    return result;
  } catch (err) {
    providerState.cfc.failures++;
    providerState.cfc.lastFailure = Date.now();
    console.error(`[Provider] CheapCARFAX failed for ${vin}: ${err.message}`);
    throw err;
  }
}

// ── Fetch from panel.cheapcarfax.net ─────────────────────────────────────────
async function fetchFromCfc(vin, type = "carfax") {
  const key = process.env.CHEAPCARFAX_API_KEY;
  if (!key) throw new Error("CCF_ERROR:CHEAPCARFAX_API_KEY not set");

  const endpoint = type === "autocheck"
    ? `${CCF_BASE}/autocheck/vin/${vin}/html`
    : `${CCF_BASE}/carfax/vin/${vin}/html`;

  console.log(`[CheapCARFAX] Fetching ${type} for ${vin}`);
  const r = await axios.get(endpoint, {
    headers: { "x-api-key": key },
    timeout: 45000,
    validateStatus: () => true,
  });

  console.log(`[CheapCARFAX] Status: ${r.status} for ${vin}`);
  if (r.status >= 400) console.log(`[CheapCARFAX] Error:`, JSON.stringify(r.data).slice(0, 300));

  if (r.status === 401) throw new Error("CCF_AUTH_ERROR:Invalid API key");
  if (r.status === 429) throw new Error("CCF_RATELIMIT:Rate limit exceeded");
  if (r.status === 400) {
    const msg = r.data?.message || "";
    if (/daily limit/i.test(msg))          throw new Error("CCF_DAILY_LIMIT:" + msg);
    if (/insufficient credits/i.test(msg)) throw new Error("CCF_LIMIT:Insufficient credits");
    if (/not found/i.test(msg))            throw new Error("CS_404:VIN not found");
    throw new Error("CCF_400:" + msg);
  }
  if (r.status >= 400) throw new Error(`CCF_${r.status}:${JSON.stringify(r.data).slice(0, 100)}`);

  const html = r.data?.html;
  if (!html) throw new Error("CCF_EMPTY_RESPONSE");

  console.log(`[CheapCARFAX] ✓ HTML report for ${vin} (${html.length} chars)`);
  return Buffer.from(html, "utf8").toString("base64");
}


/* ================================================================
   CheapCARFAX API Limits — fetches live credit/limit info from provider
================================================================ */
async function getCfcApiLimits() {
  try {
    const key = process.env.CHEAPCARFAX_API_KEY;
    if (!key) return null;
    const r = await axios.get(`${CCF_BASE}/limits`, {
      headers: { "x-api-key": key },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (r.status !== 200 || !r.data) return null;
    return {
      credits:                   r.data.credits_remaining ?? r.data.credits ?? null,
      carfax_reports_left_today: r.data.daily_remaining   ?? r.data.carfax_reports_left_today ?? null,
      daily_limit:               r.data.daily_limit       ?? Number(process.env.CCF_DAILY_HARD_LIMIT || 100),
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

const REPORT_TTL_DAYS = 30;
const MAX_AGE_MS      = REPORT_TTL_DAYS * 24 * 60 * 60 * 1000;

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
      .eq("type", t)
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
function injectReportChrome(html) {
  if (!html || typeof html !== "string") return html;

  let out = html;

  // 1. Strip third-party scripts that cause CORS errors or blank pages
  // Adobe DTM (navigates window to "undefined" URL — blanks the iframe)
  out = out.replace(/<script\b[^>]*adobedtm\.com[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<script\b[^>]*assets\.adobedtm[^>]*><\/script>/gi, "");
  out = out.replace(/<script\b[^>]*adobedtm[^>]*\/?>/gi, "");

  // Only strip connect.carsimulcast.com (auth/tracking API endpoint).
  // DO NOT strip static.carsimulcast.com or general carsimulcast.com scripts —
  // those host the CARFAX React bundle that renders the report body from __INITIAL__DATA__.
  // Stripping them = empty <body>, blank report.
  out = out.replace(/<script\b[^>]*connect\.carsimulcast\.com[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<script\b[^>]*connect\.carsimulcast\.com[^>]*\/?>/gi, "");
  out = out.replace(/<link\b[^>]*connect\.carsimulcast\.com[^>]*>/gi, "");
  // NOTE: /report_assets/carfax scripts are KEPT — they are the CARFAX React app
  // that renders the report body from __INITIAL__DATA__. Stripping them = blank page.
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

  return out;
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
   Atomic Credit Updates
================================================================ */
async function addCreditsAtomic(userId, delta) {
  const { error } = await supabaseService.rpc("add_credits", {
    p_user:  userId,
    p_delta: delta,
  });
  if (error) throw new Error(`Credit update failed: ${error.message}`);
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

async function refundAndResolve(chargeId, userId, sessionId) {
  try {
    if (userId) {
      await addCreditsAtomic(userId, 1);
      console.log(`[Refund] +1 credit to user ${userId} for charge ${chargeId}`);
    } else if (sessionId) {
      if (sessionId.startsWith("pp_")) {
        const captureId = sessionId.replace("pp_", "");
        try {
          const refundReq = new paypalSdk.payments.CapturesRefundRequest(captureId);
          refundReq.requestBody({ reason: "AutoVINReveal: VIN not found or report generation failed." });
          await ppClient.execute(refundReq);
          console.log(`[Refund] PayPal refund issued for capture ${captureId}`);
        } catch (ppErr) {
          console.error(`[Refund] FATAL: PayPal refund failed for ${captureId}:`, ppErr.message);
        }
      } else if (sessionId.startsWith("cs_")) {
        try {
          const sStripe = stripeForId(sessionId);
          const session = await sStripe.checkout.sessions.retrieve(sessionId);
          if (session.payment_intent) {
            await sStripe.refunds.create({ payment_intent: session.payment_intent, reason: "requested_by_customer" });
            console.log(`[Refund] Stripe refund issued for session ${sessionId}`);
          }
        } catch (stripeErr) {
          console.error(`[Refund] FATAL: Stripe refund failed for ${sessionId}:`, stripeErr.message);
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
// General API rate limit
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// ── Anti-scraping: strict per-IP limit on /api/report ──────────────────────
// Legitimate users run 1-5 reports. Scrapers run hundreds.
const reportRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour window
  max: 10,                     // max 10 report requests per IP per hour
  keyGenerator: (req) => {
    // Use forwarded IP (Render passes real IP in x-forwarded-for)
    return req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
  },
  message: { error: "rate_limited", message: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Don't rate limit Render health checks
    return req.path === "/health";
  },
});

// ── Track suspicious VIN patterns across requests ─────────────────────────
const suspiciousIps = new Map(); // ip → { count, firstSeen, blocked }

function trackSuspicion(ip, vin) {
  const now = Date.now();
  const entry = suspiciousIps.get(ip) || { count: 0, vins: new Set(), firstSeen: now, blocked: false };
  entry.count++;
  entry.vins.add(vin);
  entry.lastSeen = now;

  // Auto-block if: 20+ unique VINs in 1 hour from same IP
  if (entry.vins.size >= 20 && (now - entry.firstSeen) < 60 * 60 * 1000) {
    entry.blocked = true;
    console.warn(`[AntiScrape] BLOCKED IP ${ip} — ${entry.vins.size} unique VINs in ${Math.round((now - entry.firstSeen)/60000)}min`);
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
}, 60 * 60 * 1000);

const paypalCaptureLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: "Too many PayPal requests" });

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

// Must run after ppClient is defined so PayPal refunds have a live client
reconcileStalePendingCharges();

// Log provider configuration on startup
console.log(`[Provider] CheapCARFAX configured: ${!!process.env.CHEAPCARFAX_API_KEY}`);
console.log(`[Provider] CheapCARFAX ready — daily limit: ${process.env.CCF_DAILY_HARD_LIMIT || 100}`);

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

    let priceLive = PRICE_SINGLE;
    let intent    = vin ? "buy_report" : "buy_credit_single";
    if (isTwentyPack)    { priceLive = PRICE_20PACK; intent = "buy_credits_20pack"; }
    else if (isFivePack) { priceLive = PRICE_5PACK;  intent = "buy_credits_5pack"; }

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
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Stripe error" });
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
   Credits endpoint
================================================================ */
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
================================================================ */
app.post("/api/paypal/create-order", paypalCaptureLimiter, async (req, res) => {
  try {
    const { package: pkgKey, vin, user_id } = req.body;

    let customIdentifier = "";
    let description      = "";

    if (vin) {
      const v = validateVin(vin);
      if (!v.ok) return res.status(422).json({ error: "invalid_vin", reason: v.code, message: v.msg });
      customIdentifier = v.vin;
      description      = `Vehicle History Report (VIN: ${customIdentifier})`;
    } else {
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
      application_context: { shipping_preference: "NO_SHIPPING", brand_name: "AutoVINReveal" },
      purchase_units: [{
        amount: {
          currency_code: "USD",
          value: pkg.amount,
          breakdown: { item_total: { currency_code: "USD", value: pkg.amount } },
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
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
    const ua = req.headers["user-agent"] || "";

    // Block missing or bot-like User-Agents
    const suspiciousUA = !ua ||
      /python-requests|curl|wget|scrapy|go-http|java\/|libwww|axios\/[0-9]|node-fetch|bot|spider|crawl/i.test(ua);
    if (suspiciousUA) {
      console.warn(`[AntiScrape] Blocked suspicious UA from ${clientIp}: "${ua.slice(0, 80)}"`);
      return res.status(403).json({ error: "forbidden", message: "Access denied." });
    }

    // Block if this IP has been auto-blocked for scraping
    if (trackSuspicion(clientIp, targetVin)) {
      return res.status(429).json({ error: "rate_limited", message: "Too many requests." });
    }

    // Block known CARFAX/investigator IPs silently — return fake success with no data
    if (isBlockedIp(clientIp)) {
      console.warn(`[AntiCAR] Blocked known investigator IP: ${clientIp} VIN: ${targetVin}`);
      // Return fake 200 so they don't know they're blocked
      return res.status(200).send("<html><body><p>Report loading...</p></body></html>");
    }

    // Require either a logged-in user OR a valid one-time session
    // No anonymous free-for-all lookups
    const { user: earlyUser } = await getUser(req);
    if (!earlyUser && !oneTimeSession) {
      return res.status(401).json({ error: "auth_required", message: "Please log in to run reports." });
    }

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
          .eq("type", type)
          .eq("success", true)
          .maybeSingle();
        if (past) alreadyOwned = true;
      }
    }

    // 5. Live fetch
    if (!raw && allowLive) {

      if (!alreadyOwned && !oneTimeSession) {
        if (currentUser) {
          pendingChargeId = await createPendingCharge({ userId: currentUser.id, vin: targetVin });

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
          await markSessionConsumed(oneTimeSession);
          pendingChargeId = await createPendingCharge({ sessionId: oneTimeSession, vin: targetVin });
        } catch (e) {
          if (e.message === "SESSION_ALREADY_CONSUMED") {
            return res.status(400).json({ error: "receipt_already_used" });
          }
          return res.status(400).json({ error: "receipt_invalid" });
        }
      }

      try {
        const live = await cfcGetReport(targetVin, type);
        raw = live;
        writeCache(targetVin, type, raw);

        if (currentUser) {
          // Try to update existing row first (if any), then insert
          const { data: existing } = await supabaseService
            .from("vin_queries")
            .select("id")
            .eq("user_id", currentUser.id)
            .eq("vin", targetVin)
            .eq("type", type)
            .maybeSingle();

          if (existing?.id) {
            // Update the existing row with fresh report data
            const { error: updErr } = await supabaseService
              .from("vin_queries")
              .update({ report_data: raw, success: true })
              .eq("id", existing.id);
            if (updErr) console.error("[DB] Update report_data failed:", updErr.message);
            else console.log("[DB] report_data updated for", targetVin);
          } else {
            // Insert new row
            const { error: insErr } = await supabaseService
              .from("vin_queries")
              .insert({ user_id: currentUser.id, vin: targetVin, type, report_data: raw, success: true });
            if (insErr) console.error("[DB] Insert report failed:", insErr.message);
            else console.log("[DB] report_data stored for", targetVin);
          }
        }

        if (pendingChargeId) await resolvePendingCharge(pendingChargeId);

        // Decrement CFC API credit counter on every successful live fetch
        decrementCfcCredits().catch(() => {});

      } catch (e) {
        console.error(`[Fetch Failed] User: ${currentUser?.id || "guest"} | VIN: ${targetVin} | Err: ${e.message}`);

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

    if (!raw) {
      if (alreadyOwned) {
        return res.status(404).json({
          error: "report_not_cached",
          message: "This report is no longer in our cache. Please search the VIN again — you won't be charged as you already own it.",
          vin: targetVin,
          can_refetch: true,
        });
      }
      return res.status(404).json({ error: "not_found", message: "No report found." });
    }

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

      return res.send(reportHtml);
    }

    if (decoded.kind === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      return res.send(decoded.buffer);
    }

    if (pendingChargeId) {
      console.error(`[Delivery Failed] User: ${currentUser?.id || "guest"} | Bad format. Refunding.`);
      await refundAndResolve(pendingChargeId, currentUser?.id || null, oneTimeSession);
      pendingChargeId = null;
      return res.status(422).json({ error: "provider_error", message: "Report format error. You have been refunded." });
    }

    return res.status(500).json({ error: "unsupported_content" });

  } catch (err) {
    if (pendingChargeId) {
      try { await refundAndResolve(pendingChargeId, currentUser?.id || null, oneTimeSession); }
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
    const { to, vin, type = "carfax" } = req.body || {};
    if (!to || !String(to).includes("@")) return res.status(400).json({ error: "invalid_to" });

    const targetVin = (vin || "").trim().toUpperCase();
    if (!targetVin) return res.status(400).json({ error: "vin_required" });

    const raw = await getReportData(targetVin, type);
    if (!raw) return res.status(404).json({ error: "not_cached" });

    const decoded = decodeReportBase64(raw);
    const subject = `Your ${type.toUpperCase()} Vehicle History Report — ${targetVin}`;

    // Attempt real PDF generation via CarSimulcast (same as download button)
    let pdfBuffer = null;

    if (decoded.kind === "pdf") {
      pdfBuffer = decoded.buffer;
    } else if (decoded.kind === "html") {
      try {
        // PDF generation not available — will fall back to link email below
      } catch (pdfErr) {
        console.error("[email-report] PDF generation failed:", pdfErr.message);
      }
    }

    if (pdfBuffer) {
      await mailer.sendMail({
        from: SMTP_FROM, to, subject,
        text: `Your vehicle history report for VIN ${targetVin} is attached as a PDF.`,
        attachments: [{
          filename:    `${targetVin}-${type}-report.pdf`,
          content:     pdfBuffer,
          contentType: "application/pdf",
        }],
      });
      return res.json({ ok: true, format: "pdf" });
    }

    // Fallback: send a styled link email
    const reportUrl = `${SITE_URL}/view-report/${targetVin}?type=${type}`;
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
      .select("vin, type, success, created_at")
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
    if (decoded.kind === "html") {
      res.setHeader("Content-Type", "text/html");
      // BLANK-PAGE FIX: same injection as main report route
      return res.send(injectReportChrome(decoded.html));
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
        .select("id, user_id, vin, type, success, created_at")
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
      .select("vin, type, success, created_at")
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
      balance:       credRow ? credRow.balance : 0,
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
    const ccfDailyLimit = ccfLimits?.daily_limit ?? Number(process.env.CCF_DAILY_HARD_LIMIT || 100);

    // All-time report stats
    const { data: allReports } = await supabaseService
      .from("vin_queries")
      .select("vin, type, success, created_at, user_id")
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
   AI Chat Widget
================================================================ */
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [], userEmail = null } = req.body || {};
    if (!message) return res.status(400).json({ error: "message required" });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Chat not configured" });

    const systemPrompt = `ROLE: You are a live chat support agent for AutoVINReveal. You talk like a real human - short, warm, casual.

ABSOLUTE FORMATTING RULES - breaking these is your only failure mode:
ZERO markdown. No asterisks, no bold, no bullet points, no numbered lists, no dashes as list items, no headers.
Write ONLY plain sentences. To list things write them inline: "You can pay by card or PayPal."
Maximum 2 sentences per reply unless you are asking follow-up questions.
Never start with "Great question!" or "Good question!" or "Of course!" - just answer.

FACTS - never say anything outside this list:
Single report is $5.99 and needs no account. 5-pack is $20 ($4 each) and needs an account. 20-pack is $58 ($2.90 each) and needs an account.
Monthly plans: Starter $30/mo for 20 reports, Pro $98/mo for 100 reports, Premium $160/mo for 200 reports.
Reports cover accidents, odometer rollbacks, title issues, service records, open recalls.
Search by VIN or license plate plus state. Credits never expire. Pay by card or PayPal.
Failed reports are automatically refunded. Support email is support@autovinreveal.com.

IF ASKED ABOUT MISSING/FAILED REPORT - ask ONE question at a time in order:
Step 1: Ask if they got a payment confirmation email.
Step 2: Ask how long ago they paid.
Step 3: Ask if they saw an error message.
Only after getting all 3 answers say something like: "In that case email support@autovinreveal.com with your transaction ID and the VIN you searched and they will fix it fast."
Do NOT give them a list of what to include. Just say to email with transaction ID and VIN.

IF ASKED ANYTHING NOT IN THE FACTS LIST above: Say "I am not sure about that - email support@autovinreveal.com and they will help you out."
Never mention APIs, integrations, or that you lack information.

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
    ];

    const messages = [
      ...FEW_SHOT,
      ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ];

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 300, system: systemPrompt, messages },
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

    if (shouldEscalate && mailer) {
      // Email the owner with the full conversation
      const convoLines = [
        ...history.map(m => (m.role === "user" ? "User: " : "Bot: ") + m.content),
        "User: " + message,
        "Bot: " + reply,
      ];
      const convoHtml = convoLines
        .map(l => `<p style="margin:4px 0;${l.startsWith("User:") ? "color:#1e3a8a;font-weight:bold;" : "color:#475569;"}">${l}</p>`)
        .join("");

      mailer.sendMail({
        from: SMTP_FROM,
        to: SMTP_USER,
        subject: "AutoVINReveal: Chat needs your attention" + (userEmail ? " — " + userEmail : ""),
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1e3a8a;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
            <strong>Customer needs help</strong>${userEmail ? " &mdash; " + userEmail : ""}
          </div>
          <div style="border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 8px 8px;background:#f8fafc;">
            <p style="color:#64748b;font-size:13px;margin-bottom:12px;">Full conversation:</p>
            ${convoHtml}
            <hr style="margin:16px 0;border:none;border-top:1px solid #e2e8f0;"/>
            <p style="color:#64748b;font-size:12px;">Reply directly to the customer at: <a href="mailto:${userEmail || "support@autovinreveal.com"}">${userEmail || "support@autovinreveal.com"}</a></p>
          </div>
        </div>`,
      }).catch(e => console.error("[Chat escalation email failed]", e.message));
    }

    res.json({ reply, escalated: shouldEscalate });
  } catch (err) {
    console.error("Chat error:", err.response?.data || err.message);
    res.status(500).json({ error: "Chat failed" });
  }
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