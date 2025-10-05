/********************************************************************/
/* Server: project-echo backend
   Purpose: VIN reports + Supabase auth + Stripe checkout + credits.
   Supports guest checkout: one paid Stripe session = one live fetch. */
/********************************************************************/

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
// import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import Stripe from 'stripe';

/* ----------------------------- Setup ---------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1); // respect x-forwarded-* on Render/proxies
const PORT = process.env.PORT || 3000;

/* ---------------------- Middleware & Static --------------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(helmet({ contentSecurityPolicy: false }));
// app.use(morgan('dev'));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

/* --------------------------- Supabase --------------------------- */
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
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return { token: null, user: null };
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error) return { token: null, user: null };
  return { token, user: data.user };
}

/* ---------------------------- Stripe ---------------------------- */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const PRICE_ID = process.env.STRIPE_PRICE_ID;

/* ---------------------- CarSimulcast client --------------------- */
const CS = 'https://connect.carsimulcast.com';
const KEY = process.env.API_KEY;
const SECRET = process.env.API_SECRET;
const H = { 'API-KEY': KEY, 'API-SECRET': SECRET };

async function csGet(url) {
  const r = await axios.get(url, { headers: H, responseType: 'text', timeout: 30000 });
  return r.data;
}

/* ------------------------------ Cache --------------------------- */
// Use /tmp in production (ephemeral on Render) and local folder in dev
const CACHE_DIR = process.env.NODE_ENV === 'production'
  ? '/tmp/cache'
  : path.join(__dirname, 'cache');
try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

const ck = (vin, type) => path.join(CACHE_DIR, `${vin}-${type}.b64`);
const readCache = (vin, type) => (fs.existsSync(ck(vin, type)) ? fs.readFileSync(ck(vin, type), 'utf8') : null);
const writeCache = (vin, type, data) => { try { fs.writeFileSync(ck(vin, type), data, 'utf8'); } catch {} };

/* ----------------------- One-time guest receipt ----------------- */
// Ephemeral file; for durability, store in DB table instead.
const CONSUMED_FILE = (process.env.NODE_ENV === 'production' ? '/tmp' : __dirname) + '/.consumed_sessions.json';
let CONSUMED = new Set();
try {
  if (fs.existsSync(CONSUMED_FILE)) {
    const raw = fs.readFileSync(CONSUMED_FILE, 'utf8');
    CONSUMED = new Set(JSON.parse(raw));
  }
} catch {}
function saveConsumed() {
  try { fs.writeFileSync(CONSUMED_FILE, JSON.stringify([...CONSUMED], null, 2)); } catch {}
}

/* --------------------------- Healthcheck ------------------------ */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* --------------------------- Credits API ------------------------ */
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

/* -------------------- Stripe Checkout endpoint ------------------ */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { user_id, price_id } = req.body || {};

    // Auto-detect base URL (works on Render and custom domain)
    const proto = (req.headers['x-forwarded-proto'] || req.protocol) || 'https';
    const host  = req.get('host');
    const base  = process.env.SITE_URL || `${proto}://${host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: String(price_id || PRICE_ID), quantity: 1 }],
      success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${base}/cancel.html`,
      ...(user_id ? { client_reference_id: user_id, metadata: { user_id } } : {}),
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('stripe create session error:', err);
    res.status(500).json({ error: 'Stripe error' });
  }
});

/* -------------------------- VIN Report API ---------------------- */
app.post('/api/report', async (req, res) => {
  try {
    const {
      vin,
      state,
      plate,
      type = 'carfax',
      as = 'html',
      allowLive: allowLiveRaw,
      oneTimeSession, // for guest flow after Stripe success
    } = req.body || {};

    const allowLive = allowLiveRaw !== false;

    // VIN resolution (plate -> VIN)
    let targetVin = (vin || '').trim().toUpperCase();
    if (!targetVin && state && plate) {
      const txt = await csGet(`${CS}/checkplate/${state}/${plate}`);
      const m = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m) targetVin = m[0];
    }
    if (!targetVin) return res.status(400).send('VIN or Plate+State required');

    // Try cache
    let raw = readCache(targetVin, type);

    // Live fetch path (charge credit or validate guest payment)
    if (!raw && allowLive) {
      const { token, user } = await getUser(req);

      if (user) {
        // Logged-in user: consume 1 credit via RPC
        const sb = supabaseForToken(token);
        const { error: rpcErr } = await sb.rpc('use_credit_for_vin', {
          p_vin: targetVin,
          p_result_url: null,
        });
        if (rpcErr) {
          console.error('use_credit_for_vin error:', rpcErr);
          return res.status(402).send('Insufficient credits');
        }
      } else {
        // Guest must present paid Stripe session_id (single-use)
        if (!oneTimeSession) return res.status(401).send('Complete purchase to view this report.');
        if (CONSUMED.has(oneTimeSession)) return res.status(409).send('This receipt was already used.');

        try {
          const s = await stripe.checkout.sessions.retrieve(oneTimeSession);
          if (s.payment_status !== 'paid') return res.status(402).send('Payment not completed.');
          CONSUMED.add(oneTimeSession);
          saveConsumed();
        } catch (e) {
          console.error('Stripe verify session error:', e?.message || e);
          return res.status(400).send('Invalid purchase receipt.');
        }
      }

      // Fetch & cache fresh
      const live = await csGet(`${CS}/getrecord/${type}/${targetVin}`);
      raw = live;
      writeCache(targetVin, type, raw);
    }

    if (!raw) return res.status(404).send('No cached or archive report found.');

    if (as === 'pdf') {
      const form = new FormData();
      form.append('base64_content', raw);
      form.append('vin', targetVin);
      form.append('report_type', type);
      const pdf = await axios.post(`${CS}/pdf`, form, {
        headers: { ...H, ...form.getHeaders() },
        responseType: 'arraybuffer',
      });
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(Buffer.from(pdf.data));
    } else {
      const html = Buffer.from(raw, 'base64').toString('utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
  } catch (err) {
    console.error('report error:', err);
    res.status(500).send('Server error');
  }
});

/* ----------------------------- Start ---------------------------- */
const server = app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('✅ Server listening on', process.env.PORT || 3000);
});
// prevent “connection reset by peer” on slow responses
server.keepAliveTimeout = 120000;   // 120s
server.headersTimeout   = 130000;   // keepAliveTimeout + cushion
