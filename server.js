/********************************************************************/
// Name:        AutoVINReveal Server
// Date:        2025-10-08
// Purpose:     Full backend for AutoVINReveal with Stripe + PayPal
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
app.set('trust proxy', 1); // render proxy

// Force HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (!req.secure) {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
}

// Upgrade any leftover http:// requests
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests');
  next();
});

/* ================================================================
   🩺 Health + Static
================================================================ */
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

/* ================================================================
   💳 Stripe Setup
================================================================ */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const PRICE_SINGLE = process.env.STRIPE_PRICE_SINGLE;
const PRICE_10PACK = process.env.STRIPE_PRICE_10PACK;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

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
  return r.data;
}

/* ================================================================
   🧠 Caches, tokens, utilities
================================================================ */
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const ck = (vin, type) => path.join(CACHE_DIR, `${vin}-${type}.b64`);
const readCache = (vin, type) => (fs.existsSync(ck(vin, type)) ? fs.readFileSync(ck(vin, type), 'utf8') : null);
const writeCache = (vin, type, data) => fs.writeFileSync(ck(vin, type), data, 'utf8');

const CONSUMED_FILE = path.join(__dirname, '.consumed_sessions.json');
let CONSUMED = new Set();
try { if (fs.existsSync(CONSUMED_FILE)) CONSUMED = new Set(JSON.parse(fs.readFileSync(CONSUMED_FILE, 'utf8'))); } catch {}
const saveConsumed = () => { try { fs.writeFileSync(CONSUMED_FILE, JSON.stringify([...CONSUMED], null, 2)); } catch {} };

function decodeReportBase64(rawB64) {
  const buf = Buffer.from(rawB64, 'base64');
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return { kind: 'html', html: gunzipSync(buf).toString('utf8') }; }
    catch { return { kind: 'unknown', buffer: buf }; }
  }
  if (buf.slice(0,5).toString() === '%PDF-') return { kind: 'pdf', buffer: buf };
  const asText = buf.toString('utf8');
  if (/<!DOCTYPE html|<html[\s>]/i.test(asText)) return { kind: 'html', html: asText };
  return { kind: 'unknown', buffer: buf };
}

/* ================================================================
   🧾 Stripe Webhook
================================================================ */
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.user_id || session.client_reference_id;
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
      let credits = 0;
      for (const li of lineItems.data) {
        if (li.price.id === PRICE_SINGLE) credits += 1 * (li.quantity || 1);
        else if (li.price.id === PRICE_10PACK) credits += 10 * (li.quantity || 1);
      }
      if (userId && credits > 0) {
        const { data: ex } = await supabaseService.from('credits').select('balance').eq('user_id', userId).maybeSingle();
        if (ex) await supabaseService.from('credits').update({ balance: ex.balance + credits }).eq('user_id', userId);
        else await supabaseService.from('credits').insert({ user_id: userId, balance: credits });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
});

/* ================================================================
   ⚙️ Middleware (normal JSON)
================================================================ */
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

/* ================================================================
   💰 Stripe Checkout
================================================================ */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { user_id, price_id } = req.body || {};
    let price = price_id === 'STRIPE_PRICE_10PACK' ? PRICE_10PACK : PRICE_SINGLE;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price, quantity: 1 }],
      success_url: `${SITE_URL}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}?checkout=cancel`,
      ...(user_id ? { client_reference_id: user_id, metadata: { user_id } } : {})
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('stripe create session error:', e);
    res.status(500).json({ error: 'Stripe error' });
  }
});

/* ================================================================
   💵 PayPal
================================================================ */
const PAYPAL_ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const ppEnv = PAYPAL_ENV === 'live'
  ? new paypalSdk.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
  : new paypalSdk.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
const ppClient = new paypalSdk.core.PayPalHttpClient(ppEnv);

async function verifyPaypalCapture(captureId) {
  const req = new paypalSdk.payments.CapturesGetRequest(captureId);
  const res = await ppClient.execute(req);
  return res?.result;
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
    const cap = unit?.payments?.captures?.[0];
    const captureId = cap?.id;
    const status = cap?.status || capRes?.result?.status;
    if (!captureId || status !== 'COMPLETED') return res.status(400).json({ error: 'Capture not completed' });

    if (user_id) {
      const { data: ex } = await supabaseService.from('credits').select('balance').eq('user_id', user_id).maybeSingle();
      if (ex) await supabaseService.from('credits').update({ balance: (ex.balance || 0) + 1 }).eq('user_id', user_id);
      else await supabaseService.from('credits').insert({ user_id, balance: 1 });
    }

    res.json({ ok: true, captureId });
  } catch (e) {
    console.error('paypal capture error:', e);
    res.status(500).json({ error: 'PayPal capture failed' });
  }
});

/* ================================================================
   📄 Report API (Carfax)
================================================================ */
// (unchanged — keep your existing implementation from your file)

/* ================================================================
   🚀 Boot
================================================================ */
const server = app.listen(PORT, HOST, () =>
  console.log(`✅ Server running on ${process.env.SITE_URL || `http://${HOST}:${PORT}`}`)
);
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
