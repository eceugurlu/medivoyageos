import { processHotLeadFollowup } from '../../src/services/scheduler.js';
import { verifyCronSecret } from '../../src/middleware/verifyCronSecret.js';

// Same shape as postop.js/risk.js — see that file's comment for why this is
// a cron-triggered route rather than a setInterval.
export default async function handler(req, res) {
  if (!verifyCronSecret(req, res)) return;
  try {
    const followedUp = await processHotLeadFollowup();
    res.status(200).json({ ok: true, followedUp });
  } catch (err) {
    console.error('[cron] hot-lead follow-up failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}
