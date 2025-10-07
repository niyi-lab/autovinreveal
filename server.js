// server.js
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ---------- Health ----------
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---------- Static ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Stripe + Prices ----------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const PRICE_SINGLE = process.env.STRIPE_PRICE_SINGLE;   // 1 credit
const PRICE_10PACK = process.env.STRIPE_PRICE_10PACK;   // 10 credits
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

// ---------- Supabase ----------
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

// ---------- CarSimulcast ----------
const CS = 'https://connect.carsimulcast.com';
const KEY = process.env.API_KEY;
const SECRET = process.env.API_SECRET;
const H = { 'API-KEY': KEY, 'API-SECRET': SECRET };

async function csGet(url) {
  const r = await axios.get(url, { headers: H, responseType: 'text', timeout: 30000 });
  return r.data; // base64 string (gzipped HTML OR raw HTML-base64 OR raw PDF-base64)
}

// ---------- Cache ----------
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const ck = (vin, type) => path.join(CACHE_DIR, `${vin}-${type}.b64`);
const readCache = (vin, type) => (fs.existsSync(ck(vin, type)) ? fs.readFileSync(ck(vin, type), 'utf8') : null);
const writeCache = (vin, type, data) => fs.writeFileSync(ck(vin, type), data, 'utf8');

// ---------- Guest receipt tracker ----------
const CONSUMED_FILE = path.join(__dirname, '.consumed_sessions.json');
let CONSUMED = new Set();
try {
  if (fs.existsSync(CONSUMED_FILE)) CONSUMED = new Set(JSON.parse(fs.readFileSync(CONSUMED_FILE, 'utf8')));
} catch {}
function saveConsumed() {
  try { fs.writeFileSync(CONSUMED_FILE, JSON.stringify([...CONSUMED], null, 2)); } catch {}
}

// ---------- Helpers ----------
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

// ---------- Share links (24h tokens) ----------
const SHARE_FILE = path.join(__dirname, '.share_tokens.json');
let SHARE_TOKENS = {};
try {
  if (fs.existsSync(SHARE_FILE)) SHARE_TOKENS = JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8'));
} catch {}
function saveShareTokens() { try { fs.writeFileSync(SHARE_FILE, JSON.stringify(SHARE_TOKENS, null, 2)); } catch {} }
function makeToken() { return Buffer.from(crypto.randomUUID()).toString('base64url').replace(/=/g,''); }
function pruneShareTokens() {
  const now = Date.now();
  let changed = false;
  for (const [tok, meta] of Object.entries(SHARE_TOKENS)) {
    if (!meta || meta.exp <= now) { delete SHARE_TOKENS[tok]; changed = true; }
  }
  if (changed) saveShareTokens();
}
setInterval(pruneShareTokens, 60 * 60 * 1000); // hourly cleanup

// ========== STRIPE WEBHOOK (raw body) ==========
// must be before app.use(express.json())
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.user_id || session.client_reference_id || null;
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });

      let creditsToAdd = 0;
      for (const li of lineItems.data) {
        if (li.price.id === PRICE_SINGLE)      creditsToAdd += (li.quantity || 1) * 1;
        else if (li.price.id === PRICE_10PACK) creditsToAdd += (li.quantity || 1) * 10;
      }

      if (!userId || creditsToAdd <= 0) return res.json({ ok: true, guest_or_zero: true });

      // Upsert credits
      const { data: existing, error: selErr } = await supabaseService
        .from('credits')
        .select('user_id,balance')
        .eq('user_id', userId)
        .maybeSingle();
      if (selErr) throw selErr;

      if (existing) {
        const { error: upErr } = await supabaseService
          .from('credits')
          .update({ balance: existing.balance + creditsToAdd })
          .eq('user_id', userId);
        if (upErr) throw upErr;
      } else {
        const { error: insErr } = await supabaseService
          .from('credits')
          .insert({ user_id: userId, balance: creditsToAdd });
        if (insErr) throw insErr;
      }

      return res.json({ ok: true, added: creditsToAdd });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err?.message || err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ========== NORMAL MIDDLEWARE (after webhook) ==========
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// ---------- Credits API ----------
app.get('/api/credits/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const { data, error } = await supabaseService
      .from('credits')
      .select('balance')
      .eq('user_id', user_id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ balance: data?.balance ?? 0 });
  } catch (err) {
    console.error('credits error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Stripe Checkout ----------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { user_id, price_id } = req.body || {};
    let price;
    if (price_id === 'STRIPE_PRICE_SINGLE') price = PRICE_SINGLE;
    else if (price_id === 'STRIPE_PRICE_10PACK') price = PRICE_10PACK;
    else price = PRICE_SINGLE;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price, quantity: 1 }],
      success_url: `${SITE_URL}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}?checkout=cancel`,
      ...(user_id ? { client_reference_id: user_id, metadata: { user_id } } : {}),
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('stripe create session error:', err);
    res.status(500).json({ error: 'Stripe error' });
  }
});

// ---------- Report API ----------
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

    let targetVin = (vin || '').trim().toUpperCase();
    if (!targetVin && state && plate) {
      const txt = await csGet(`${CS}/checkplate/${state}/${plate}`);
      const m = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m) targetVin = m[0];
    }
    if (!targetVin) return res.status(400).send('VIN or Plate+State required');

    let raw = readCache(targetVin, type);

    if (!raw && allowLive) {
      const { token, user } = await getUser(req);

      if (user) {
        const supabaseUser = supabaseForToken(token);
        const { error: rpcErr } = await supabaseUser.rpc('use_credit_for_vin', {
          p_vin: targetVin,
          p_result_url: null,
        });
        if (rpcErr) {
          console.error('use_credit_for_vin error:', rpcErr);
          return res.status(402).send('Insufficient credits');
        }
      } else {
        if (!oneTimeSession) return res.status(401).send('Complete purchase to view this report.');
        if (CONSUMED.has(oneTimeSession)) return res.status(409).send('This receipt was already used.');
        try {
          const s = await stripe.checkout.sessions.retrieve(oneTimeSession);
          if (s.payment_status !== 'paid') return res.status(402).send('Payment not completed.');
          CONSUMED.add(oneTimeSession); saveConsumed();
        } catch (err) {
          console.error('Stripe verify session error:', err?.message || err);
          return res.status(400).send('Invalid purchase receipt.');
        }
      }

      const live = await csGet(`${CS}/getrecord/${type}/${targetVin}`);
      raw = live;
      writeCache(targetVin, type, raw);
    }

    if (!raw) return res.status(404).send('No cached or archive report found.');

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

// ---------- Share link APIs ----------
// Create a share link for a cached report (no extra billing; just serves from cache)
app.post('/api/share', async (req, res) => {
  try {
    const { vin, type = 'carfax' } = req.body || {};
    if (!vin) return res.status(400).json({ error: 'vin required' });

    const raw = readCache(vin.toUpperCase(), type);
    if (!raw) return res.status(404).json({ error: 'Report not cached yet. Open it once first.' });

    const token = makeToken();
    const exp = Date.now() + 24 * 60 * 60 * 1000; // 24h
    SHARE_TOKENS[token] = { vin: vin.toUpperCase(), type, exp };
    saveShareTokens();

    const url = `${SITE_URL}/view/${token}`;
    res.json({ url, expiresAt: exp });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// Resolve a share token and stream the cached report
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

// ---------- Boot ----------
const server = app.listen(PORT, HOST, () =>
  console.log(`✅ Server running on ${process.env.SITE_URL || `http://${HOST}:${PORT}`}`)
);
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
