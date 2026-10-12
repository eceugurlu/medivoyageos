import { processNoShowRisk } from '../../src/services/scheduler.js';
import { verifyCronSecret } from '../../src/middleware/verifyCronSecret.js';

// Same shape as postop.js — see that file's comment for why this exists as a
// cron-triggered route instead of a setInterval.
export default async function handler(req, res) {
  if (!verifyCronSecret(req, res)) return;
  try {
    const scored = await processNoShowRisk();
    res.status(200).json({ ok: true, scored });
  } catch (err) {
    console.error('[cron] no-show risk failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}
