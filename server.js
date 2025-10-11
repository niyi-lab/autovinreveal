/********************************************************************/
// Name:        AutoVINReveal Server
// Date:        2025-10-11
// Purpose:     Stripe + PayPal backend with instant report delivery
//              credit bundles, safe guest flow, and report caching.
/********************************************************************/

import dotenv from 'dotenv';
dotenv.config({ path: '/etc/secrets/.env' }); // Render Secret File (if used)
dotenv.config(); // fallback local .env

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import Stripe from 'stripe';
import { gunzipSync } from 'zlib';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const paypalSdk = require('@paypal/checkout-server-sdk');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

/* ================================================================
   🔒 Secure-by-default
================================================================ */
app.set('trust proxy', 1);

/** Exempt machine callbacks from HTTPS redirects (esp. Stripe). */
const HTTPS_EXEMPT_RE = /^\/api\/stripe-webhook(?:\/|$)/i;

if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    // Never redirect the Stripe webhook
    if (HTTPS_EXEMPT_RE.test(req.originalUrl)) return next();

    // Some hosts send "https,http" — only the first value matters.
    const xfProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();

    if (req.secure || xfProto === 'https') return next();

    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  });
}

// This header is fine; it doesn't affect the webhook.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests');
  next();
});

/* ================================================================
   🩺 Health
================================================================ */
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/* ================================================================
   💳 Stripe Setup (live default, optional test)
================================================================ */
const stripeLive = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const STRIPE_TEST_SECRET_KEY = process.env.STRIPE_TEST_SECRET_KEY || null;

const PRICE_SINGLE      = process.env.STRIPE_PRICE_SINGLE;       // e.g. price_XXXX
const PRICE_10PACK      = process.env.STRIPE_PRICE_10PACK;       // e.g. price_YYYY
const PRICE_SINGLE_TEST = process.env.STRIPE_PRICE_SINGLE_TEST || null;
const PRICE_10PACK_TEST = process.env.STRIPE_PRICE_10PACK_TEST || null;

const CREDITS_PER_SINGLE = Number(process.env.CREDITS_PER_SINGLE || '1');
const CREDITS_PER_10PACK = Number(process.env.CREDITS_PER_10PACK || '10');

const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

function stripeForId(id) {
  const isTest = typeof id === 'string' && id.startsWith('cs_test_');
  if (isTest) {
    if (!STRIPE_TEST_SECRET_KEY) throw new Error('Test session but STRIPE_TEST_SECRET_KEY not set.');
    return new Stripe(STRIPE_TEST_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return stripeLive;
}

/* ================================================================
   🗄️ Supabase
================================================================ */
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY;

const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const supabaseService = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const supabaseForToken = (token) =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });

async function getUser(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return { token: null, user: null };
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error) return { token: null, user: null };
  return { token, user: data.user };
}

/* ================================================================
   🚗 CarSimulcast API
================================================================ */
const CS = 'https://connect.carsimulcast.com';
const KEY = process.env.API_KEY;
const SECRET = process.env.API_SECRET;
const H = { 'API-KEY': KEY, 'API-SECRET': SECRET };

async function csGet(url) {
  const r = await axios.get(url, { headers: H, responseType: 'text', timeout: 30000 });
  return r.data; // base64 (gzipped HTML OR raw HTML-base64 OR raw PDF-base64)
}

/* ================================================================
   🧠 Cache / tokens / helpers
================================================================ */
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const ck = (vin, type) => path.join(CACHE_DIR, `${vin}-${type}.b64`);
const readCache = (vin, type) => (fs.existsSync(ck(vin, type)) ? fs.readFileSync(ck(vin, type), 'utf8') : null);
const writeCache = (vin, type, data) => fs.writeFileSync(ck(vin, type), data, 'utf8');

const CONSUMED_FILE = path.join(__dirname, '.consumed_sessions.json');
let CONSUMED = new Set();
try {
  if (fs.existsSync(CONSUMED_FILE)) CONSUMED = new Set(JSON.parse(fs.readFileSync(CONSUMED_FILE, 'utf8')));
} catch {}
function saveConsumed() {
  try { fs.writeFileSync(CONSUMED_FILE, JSON.stringify([...CONSUMED], null, 2)); } catch {}
}

function decodeReportBase64(rawB64) {
  const buf = Buffer.from(rawB64, 'base64');
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return { kind: 'html', html: gunzipSync(buf).toString('utf8') }; }
    catch { return { kind: 'unknown', buffer: buf, error: 'gunzip-failed' }; }
  }
  if (buf.slice(0, 5).toString() === '%PDF-') return { kind: 'pdf', buffer: buf };
  const asText = buf.toString('utf8');
  if (/<!DOCTYPE html|<html[\s>]/i.test(asText.slice(0, 2048))) return { kind: 'html', html: asText };
  return { kind: 'unknown', buffer: buf };
}

async function fetchAndCacheReport(vin, type = 'carfax') {
  const live = await csGet(`${CS}/getrecord/${type}/${vin}`);
  writeCache(vin, type, live);
  return true;
}

/* ================================================================
   🧾 Stripe Webhook (dual-secret verify)
   NOTE: This MUST stay before express.json()
================================================================ */
const WH_LIVE = process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET;
const WH_TEST = process.env.STRIPE_WEBHOOK_SECRET_TEST || null;

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripeLive.webhooks.constructEvent(req.body, sig, WH_LIVE);
  } catch (e1) {
    if (WH_TEST) {
      try { event = stripeLive.webhooks.constructEvent(req.body, sig, WH_TEST); }
      catch (e2) { console.error('Webhook verify failed (both):', e1?.message, e2?.message); return res.status(400).send('Webhook signature verification failed'); }
    } else {
      console.error('Webhook verify failed (live only):', e1?.message);
      return res.status(400).send('Webhook signature verification failed');
    }
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Use matching Stripe key to read line items (works for test & live).
      const stripeForSession = stripeForId(session.id);
      const lineItems = await stripeForSession.checkout.sessions.listLineItems(session.id, { limit: 10 });

      // Compute credits explicitly
      let creditsToAdd = 0;
      for (const li of lineItems.data) {
        const pid = li.price?.id;
        const qty = li.quantity || 1;
        if (pid === PRICE_SINGLE || pid === PRICE_SINGLE_TEST) {
          creditsToAdd += qty * CREDITS_PER_SINGLE;
        } else if (pid === PRICE_10PACK || pid === PRICE_10PACK_TEST) {
          creditsToAdd += qty * CREDITS_PER_10PACK;
        } else {
          // Unknown price => treat as 1 credit
          creditsToAdd += qty * CREDITS_PER_SINGLE;
        }
      }

      const userId  = session.metadata?.user_id || session.client_reference_id || null;
      const intent  = session.metadata?.intent || '';
      const metaVin = (session.metadata?.vin || '').toUpperCase();
      const metaType = (session.metadata?.report_type || 'carfax').toLowerCase();

      // Credit account (if known user)
      if (userId && creditsToAdd > 0) {
        const { data: existing } = await supabaseService
          .from('credits').select('balance').eq('user_id', userId).maybeSingle();
        if (existing) {
          await supabaseService.from('credits')
            .update({ balance: (existing.balance || 0) + creditsToAdd }).eq('user_id', userId);
        } else {
          await supabaseService.from('credits').insert({ user_id: userId, balance: creditsToAdd });
        }
      }

      // Instant fulfillment for direct report purchases
      if (intent === 'buy_report' && metaVin) {
        try {
          await fetchAndCacheReport(metaVin, metaType);
          if (userId) {
            await supabaseService.from('transactions').insert({
              user_id: userId, vin: metaVin, session_id: session.id, provider: 'stripe'
            });
          }
          console.log(`✅ Webhook fulfilled report for ${metaVin}`);
        } catch (e) {
          console.error('Instant fulfillment error:', e?.message || e);
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Webhook handler error:', e?.message || e);
    res.status(500).send('Webhook handler error');
  }
});

/* ================================================================
   ⚙️ Normal middleware (after webhook)
================================================================ */
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

/* ================================================================
   💰 Stripe Checkout (prevent re-buy for cached VIN)
================================================================ */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { user_id: userIdFromBody, price_id, vin, report_type } = req.body || {};
    let userId = userIdFromBody;
    if (!userId) {
      const { user } = await getUser(req);
      if (user?.id) userId = user.id;
    }

    // Determine price to use: allow direct price_... or symbolic alias.
    const isTenPackAlias = price_id === 'STRIPE_PRICE_10PACK' || price_id === '10pack';
    const isSingleAlias  = price_id === 'STRIPE_PRICE_SINGLE' || price_id === 'single';
    const priceToUse =
      price_id?.startsWith('price_')
        ? price_id
        : (isTenPackAlias ? PRICE_10PACK : PRICE_SINGLE);

    if (!priceToUse) {
      return res.status(500).json({ error: 'Missing Stripe price id' });
    }

    // If VIN present and report already cached => don't sell it again
    if (vin) {
      const type = (report_type || 'carfax').toLowerCase();
      const cached = readCache((vin || '').toUpperCase(), type);
      if (cached) {
        return res.status(409).json({ alreadyCached: true, vin, report_type: type });
      }
    }

    const intent = vin ? 'buy_report' : (isTenPackAlias ? 'buy_credits_bundle' : 'buy_credit_single');

    const session = await stripeLive.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceToUse, quantity: 1 }],
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&intent=${encodeURIComponent(intent)}${vin ? `&vin=${encodeURIComponent(vin)}` : ''}`,
      cancel_url: `${SITE_URL}/?checkout=cancel`,
      ...(userId ? { client_reference_id: userId } : {}),
      metadata: {
        ...(userId ? { user_id: userId } : {}),
        ...(vin ? { vin } : {}),
        ...(report_type ? { report_type } : {}),
        intent,
        purchase_kind: isTenPackAlias ? 'bundle' : 'single'
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('stripe create session error:', err);
    res.status(500).json({ error: 'Stripe error' });
  }
});

/* ================================================================
   🔢 Credits API
================================================================ */
app.get('/api/credits/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const { data, error } = await supabaseService
      .from('credits').select('balance').eq('user_id', user_id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ balance: data?.balance ?? 0 });
  } catch (err) {
    console.error('credits error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ================================================================
   💵 PayPal
================================================================ */
const PAYPAL_ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const ppEnv =
  PAYPAL_ENV === 'live'
    ? new paypalSdk.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new paypalSdk.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
const ppClient = new paypalSdk.core.PayPalHttpClient(ppEnv);

async function verifyPaypalCapture(captureId) {
  const req = new paypalSdk.payments.CapturesGetRequest(captureId);
  const res = await ppClient.execute(req);
  return res?.result; // status === 'COMPLETED'
}

app.post('/api/paypal/create-order', async (_req, res) => {
  try {
    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: '7.00' } }],
      application_context: {
        brand_name: 'AutoVINReveal',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW'
      }
    });
    const order = await ppClient.execute(request);
    res.json({ orderID: order.result.id });
  } catch (e) {
    console.error('paypal create order error:', e);
    res.status(500).json({ error: 'PayPal create-order failed' });
  }
});

app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    const { orderID, user_id } = req.body || {};
    if (!orderID) return res.status(400).json({ error: 'orderID required' });

    const capReq = new paypalSdk.orders.OrdersCaptureRequest(orderID);
    capReq.requestBody({});
    const capRes = await ppClient.execute(capReq);

    const unit = capRes?.result?.purchase_units?.[0];
    const cap  = unit?.payments?.captures?.[0];
    const captureId = cap?.id || null;
    const status    = cap?.status || capRes?.result?.status;

    if (!captureId || status !== 'COMPLETED')
      return res.status(400).json({ error: 'Capture not completed', status });

    if (user_id) {
      const { data: existing } = await supabaseService
        .from('credits').select('balance').eq('user_id', user_id).maybeSingle();
      if (existing) {
        await supabaseService
          .from('credits').update({ balance: (existing.balance || 0) + 1 }).eq('user_id', user_id);
      } else {
        await supabaseService
          .from('credits').insert({ user_id, balance: 1 });
      }
    }

    res.json({ ok: true, captureId });
  } catch (e) {
    console.error('paypal capture error:', e?.message || e);
    res.status(500).json({ error: 'PayPal capture failed' });
  }
});

/* ================================================================
   📄 Report API
================================================================ */
app.post('/api/report', async (req, res) => {
  try {
    const {
      vin,
      state,
      plate,
      type = 'carfax',
      as = 'html',
      allowLive: allowLiveRaw,
      oneTimeSession,
    } = req.body || {};

    const allowLive = allowLiveRaw !== false;

    // Resolve VIN
    let targetVin = (vin || '').trim().toUpperCase();
    if (!targetVin && state && plate) {
      const txt = await csGet(`${CS}/checkplate/${state}/${plate}`);
      const m = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m) targetVin = m[0];
    }
    if (!targetVin) return res.status(400).send('VIN or Plate+State required');

    // One-time receipt verification (guest or logged-in single-use)
    if (oneTimeSession) {
      if (CONSUMED.has(oneTimeSession)) return res.status(409).send('This receipt was already used.');
      try {
        if (oneTimeSession.startsWith('pp_')) {
          const captureId = oneTimeSession.slice(3);
          const cap = await verifyPaypalCapture(captureId);
          if (cap?.status !== 'COMPLETED') return res.status(402).send('Payment not completed.');
        } else {
          const sStripe = stripeForId(oneTimeSession);
          const s = await sStripe.checkout.sessions.retrieve(oneTimeSession);
          if (s.payment_status !== 'paid') return res.status(402).send('Payment not completed.');
        }
        CONSUMED.add(oneTimeSession); saveConsumed();
      } catch (err) {
        console.error('One-time verify error:', err?.message || err);
        return res.status(400).send('Invalid purchase receipt.');
      }
    }

    // Cache check
    let raw = readCache(targetVin, type);

    // If not cached and allowed, bill correctly then fetch
    if (!raw && allowLive) {
      const { token, user } = await getUser(req);

      if (user && !oneTimeSession) {
        const supabaseUser = supabaseForToken(token);
        const { error: rpcErr } = await supabaseUser.rpc('use_credit_for_vin', {
          p_vin: targetVin,
          p_result_url: null,
        });
        if (rpcErr) {
          console.error('use_credit_for_vin error:', rpcErr);
          return res.status(402).send('Insufficient credits');
        }
      } else if (!user && !oneTimeSession) {
        return res.status(401).send('Complete purchase to view this report.');
      }

      const live = await csGet(`${CS}/getrecord/${type}/${targetVin}`);
      raw = live;
      writeCache(targetVin, type, raw);
    }

    if (!raw) return res.status(404).send('No cached or archive report found.');

    // Output
    const decoded = decodeReportBase64(raw);

    if (as === 'pdf') {
      if (decoded.kind === 'pdf') {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${targetVin}-${type}.pdf"`);
        return res.send(decoded.buffer);
      }
      if (decoded.kind === 'html') {
        try {
          const form = new FormData();
          form.append('base64_content', Buffer.from(decoded.html, 'utf8').toString('base64'));
          form.append('vin', targetVin);
          form.append('report_type', type);
          const pdf = await axios.post(`${CS}/pdf`, form, {
            headers: { ...H, ...form.getHeaders() },
            responseType: 'arraybuffer',
            timeout: 60000,
          });
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${targetVin}-${type}.pdf"`);
          return res.send(Buffer.from(pdf.data));
        } catch (e) {
          console.error('pdf conversion error:', e?.response?.status, e?.message);
          return res.status(502).send('Could not generate PDF from this report.');
        }
      }
      return res.status(500).send('Unsupported report content.');
    }

    if (decoded.kind === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(decoded.html);
    }
    if (decoded.kind === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${targetVin}-${type}.pdf"`);
      return res.send(decoded.buffer);
    }
    return res.status(500).send('Unsupported report content.');
  } catch (err) {
    console.error('report error:', err);
    res.status(500).send('Server error');
  }
});

/* ================================================================
   🔗 Share links (cache-only)
================================================================ */
const SHARE_FILE = path.join(__dirname, '.share_tokens.json');
let SHARE_TOKENS = {};
try { if (fs.existsSync(SHARE_FILE)) SHARE_TOKENS = JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8')); } catch {}
function saveShareTokens() { try { fs.writeFileSync(SHARE_FILE, JSON.stringify(SHARE_TOKENS, null, 2)); } catch {} }
function makeToken() { return Buffer.from(crypto.randomUUID()).toString('base64url').replace(/=/g,''); }
function pruneShareTokens() {
  const now = Date.now(); let changed = false;
  for (const [tok, meta] of Object.entries(SHARE_TOKENS)) {
    if (!meta || meta.exp <= now) { delete SHARE_TOKENS[tok]; changed = true; }
  }
  if (changed) saveShareTokens();
}
setInterval(pruneShareTokens, 60 * 60 * 1000);

app.post('/api/share', async (req, res) => {
  try {
    const { vin, type = 'carfax' } = req.body || {};
    if (!vin) return res.status(400).json({ error: 'vin required' });

    const raw = readCache(vin.toUpperCase(), type);
    if (!raw) return res.status(404).json({ error: 'Report not cached yet. Open it once first.' });

    const token = makeToken();
    const exp = Date.now() + 24 * 60 * 60 * 1000;
    SHARE_TOKENS[token] = { vin: vin.toUpperCase(), type, exp };
    saveShareTokens();

    const url = `${SITE_URL}/view/${token}`;
    res.json({ url, expiresAt: exp });
  } catch {
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

app.get('/view/:token', async (req, res) => {
  pruneShareTokens();
  const t = req.params.token;
  const meta = SHARE_TOKENS[t];
  if (!meta || meta.exp <= Date.now()) return res.status(404).send('Link expired or invalid');

  const raw = readCache(meta.vin, meta.type);
  if (!raw) return res.status(404).send('Report not found in cache');

  const decoded = decodeReportBase64(raw);
  if (decoded.kind === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(decoded.html);
  }
  if (decoded.kind === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${meta.vin}-${meta.type}.pdf"`);
    return res.send(decoded.buffer);
  }
  return res.status(500).send('Unsupported report content.');
});

/* ================================================================
   🔍 Route dump (debug)
================================================================ */
function dumpRoutes() {
  const routes = [];
  app._router?.stack?.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).map(k => k.toUpperCase()).join(',');
      routes.push(`${methods} ${m.route.path}`);
    } else if (m.name === 'router' && m.handle.stack) {
      m.handle.stack.forEach((h) => {
        if (h.route && h.route.path) {
          const methods = Object.keys(h.route.methods).map(k => k.toUpperCase()).join(',');
          routes.push(`${methods} ${h.route.path}`);
        }
      });
    }
  });
  console.log('Mounted routes:\n' + routes.join('\n'));
}

/* ================================================================
   🗂️ Static (LAST)
================================================================ */
app.use(express.static(path.join(__dirname, 'public')));

/* ================================================================
   🚀 Boot
================================================================ */
const server = app.listen(PORT, HOST, () =>
  console.log(`✅ Server running on ${process.env.SITE_URL || `http://${HOST}:${PORT}`}`)
);
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

dumpRoutes();
