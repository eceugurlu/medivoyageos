import { processWeeklyReport } from '../../src/services/scheduler.js';
import { verifyCronSecret } from '../../src/middleware/verifyCronSecret.js';

// Same shape as postop.js/risk.js. Scheduled for Mondays only in vercel.json
// (Vercel Hobby's cron granularity is daily at most, which a single weekday
// schedule fits fine — unlike a sub-daily schedule would) — but the handler
// itself also re-checks clinic-local Monday-ness via scheduler.js, so it's
// safe even if triggered on the wrong day by an external pinger using
// CRON_SECRET directly.
export default async function handler(req, res) {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await processWeeklyReport();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron] weekly report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}
