// api/create-checkout-session.js
import { stripe, STRIPE_PRICE_ID, SITE_URL } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id, price_id } = req.body || {};
    const price = String(price_id || STRIPE_PRICE_ID);

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
}
