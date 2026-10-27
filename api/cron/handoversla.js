import { processHandoverSla } from '../../src/services/scheduler.js';
import { verifyCronSecret } from '../../src/middleware/verifyCronSecret.js';

// Same shape as postop.js/risk.js — see postop.js's comment for why this
// exists as a cron-triggered route instead of a setInterval. Runs more
// often than the others (every 5 minutes, see vercel.json) since a 10-minute
// first-reminder threshold needs finer-grained checking than the daily jobs do.
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
