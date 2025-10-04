// api/credits.js
import { supabaseServer } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user_id = req.query?.user_id || req.query?.id;
  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id parameter' });
  }

  try {
    const { data, error } = await supabaseServer
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
}
