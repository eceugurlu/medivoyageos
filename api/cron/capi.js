import { processConversionEvents } from '../../src/services/scheduler.js';
import { verifyCronSecret } from '../../src/middleware/verifyCronSecret.js';

// Aynı şekil: postop.js/handoversla.js. Meta Conversions API kuyruğunu
// boşaltır. Beş dakikada bir (bkz. vercel.json) — dönüşümü geç bildirmek
// atfetme penceresini kaçırabilir, erken bildirmenin zararı yok.
export default async function handler(req, res) {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await processConversionEvents();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron] capi flush failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}
