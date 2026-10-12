import { processPostOp } from '../../src/services/scheduler.js';
import { verifyCronSecret } from '../../src/middleware/verifyCronSecret.js';

// Vercel Cron hits this on a schedule (see vercel.json) instead of the
// setInterval src/server.js uses locally — a serverless function can't keep a
// timer running between invocations.
export default async function handler(req, res) {
  if (!verifyCronSecret(req, res)) return;
  try {
    const processed = await processPostOp();
    res.status(200).json({ ok: true, processed });
  } catch (err) {
    console.error('[cron] post-op failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}
