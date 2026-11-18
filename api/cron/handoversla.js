import { processHandoverSla } from '../../src/services/scheduler.js';
import { verifyCronSecret } from '../../src/middleware/verifyCronSecret.js';

// Same shape as postop.js/risk.js — see postop.js's comment for why this
// exists as a cron-triggered route instead of a setInterval. Ideally runs
// every 5 minutes (a 10-minute first-reminder threshold needs it), but Vercel
// Hobby rejects any deployment with a cron that fires more than once a day,
// so vercel.json schedules it daily. On Pro, set it back to "*/5 * * * *".
export default async function handler(req, res) {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await processHandoverSla();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron] handover SLA failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}
