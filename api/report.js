// api/report.js
import {
  csGet, readCache, writeCache,
  getUserFromReq, supabaseForToken, stripe,
  isSessionConsumed, markSessionConsumed
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

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
      const txt = await csGet(`https://connect.carsimulcast.com/checkplate/${state}/${plate}`);
      const m = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m) targetVin = m[0];
    }
    if (!targetVin) return res.status(400).send('VIN or Plate+State required');

    // Try cache
    let raw = readCache(targetVin, type);

    if (!raw && allowLive) {
      // Auth check
      const { token, user } = await getUserFromReq(req);

      if (user) {
        // Logged-in: consume 1 credit via RPC
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
        // Guest must present paid Stripe session_id + one-time guard
        if (!oneTimeSession) return res.status(401).send('Complete purchase to view this report.');

        // Prevent reuse
        if (await isSessionConsumed(oneTimeSession)) {
          return res.status(409).send('This receipt was already used.');
        }

        let s;
        try {
          s = await stripe.checkout.sessions.retrieve(oneTimeSession);
        } catch (e) {
          console.error('Stripe verify error:', e?.message || e);
          return res.status(400).send('Invalid purchase receipt.');
        }
        if (s.payment_status !== 'paid') {
          return res.status(402).send('Payment not completed.');
        }

        await markSessionConsumed(oneTimeSession);
      }

      // Fetch & cache fresh
      const live = await csGet(`https://connect.carsimulcast.com/getrecord/${type}/${targetVin}`);
      raw = live;
      writeCache(targetVin, type, raw);
    }

    if (!raw) return res.status(404).send('No cached or archive report found.');

    if (as === 'pdf') {
      // Convert b64 -> pdf bytes via CarSimulcast
      const formData = new URLSearchParams();
      formData.set('base64_content', raw);
      formData.set('vin', targetVin);
      formData.set('report_type', type);

      const r = await fetch('https://connect.carsimulcast.com/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(buf);
    } else {
      const html = Buffer.from(raw, 'base64').toString('utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
  } catch (err) {
    console.error('report error:', err);
    res.status(500).send('Server error');
  }
}
