// api/_lib.js
import Stripe from 'stripe';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// --------- ENV ---------
export const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
export const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
export const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY;

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
export const STRIPE_PRICE_ID   = process.env.STRIPE_PRICE_ID; // $8 price
export const SITE_URL          = process.env.SITE_URL || 'http://localhost:3000';

export const API_KEY    = process.env.API_KEY;
export const API_SECRET = process.env.API_SECRET;

// --------- Clients ---------
export const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

export const supabaseAnon   = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const supabaseServer = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// For user token-bound calls
export const supabaseForToken = (token) =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

// --------- Auth helper ---------
export async function getUserFromReq(req) {
  const auth = req.headers?.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { token: null, user: null };
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error) return { token: null, user: null };
  return { token, user: data.user };
}

// --------- CarSimulcast ---------
const CS = 'https://connect.carsimulcast.com';
const H  = { 'API-KEY': API_KEY, 'API-SECRET': API_SECRET };

export async function csGet(url) {
  const r = await axios.get(url, { headers: H, responseType: 'text', timeout: 30000 });
  return r.data;
}

// --------- Cache (ephemeral on Vercel) ---------
// Use /tmp on serverless; it's writable but resets frequently.
const CACHE_DIR = '/tmp/cache';
try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

const ck = (vin, type) => path.join(CACHE_DIR, `${vin}-${type}.b64`);

export function readCache(vin, type) {
  try {
    const p = ck(vin, type);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } catch { return null; }
}

export function writeCache(vin, type, data) {
  try {
    fs.writeFileSync(ck(vin, type), data, 'utf8');
  } catch {}
}

// --------- One-time guest receipt (persist in Supabase) ---------
// Create a table:
//   create table if not exists consumed_sessions (
//     session_id text primary key,
//     created_at timestamp with time zone default now()
//   );
export async function isSessionConsumed(session_id) {
  const { data, error } = await supabaseServer
    .from('consumed_sessions')
    .select('session_id')
    .eq('session_id', session_id)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function markSessionConsumed(session_id) {
  const { error } = await supabaseServer
    .from('consumed_sessions')
    .insert({ session_id });
  if (error && error.code !== '23505') throw error; // ignore duplicates
}
