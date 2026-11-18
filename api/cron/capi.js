import { processConversionEvents } from '../../src/services/scheduler.js';
import { verifyCronSecret } from '../../src/middleware/verifyCronSecret.js';

// Aynı şekil: postop.js/handoversla.js. Meta Conversions API kuyruğunu
// boşaltır. İdealde beş dakikada bir çalışmalı — dönüşümü geç bildirmek
// atfetme penceresini kaçırabilir. Ama Vercel Hobby planı günde birden sık
// çalışan cron'u yayında reddediyor, o yüzden vercel.json'da günde bir.
// Pro'ya geçince "*/5 * * * *" yapılmalı.
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
