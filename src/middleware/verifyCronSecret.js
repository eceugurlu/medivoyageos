import crypto from 'node:crypto';
import { config, isProduction } from '../config.js';

// Shared by every api/cron/*.js route. Compares via SHA-256 digests, same
// reasoning as the panel token check in routes/api.js: a wrong-length header
// can't short-circuit timingSafeEqual, and the secret itself is never used
// directly as a Buffer-length oracle. The three cron files used to each do a
// plain `auth !== 'Bearer '+secret` string compare — fine functionally, but
// inconsistent with how every other bearer secret in this app is checked,
// and the next cron route added would have copied the weaker version again.
export function verifyCronSecret(req, res) {
  if (!config.cronSecret) {
    // These jobs send real messages to real patients (post-op check-ins,
    // follow-ups). Left open on a public URL, anyone could run them on demand
    // and make the clinic spam its own patient list, so an unset secret is a
    // refusal in production rather than an invitation.
    if (isProduction) {
      console.error(
        '[cron] REJECTED: CRON_SECRET is not set on this production deployment, so scheduled jobs ' +
          'cannot be distinguished from anonymous requests. Set CRON_SECRET to enable them.',
      );
      res.status(503).json({ error: 'Cron authentication is not configured' });
      return false;
    }
    return true; // local dev only
  }
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(config.cronSecret).digest();
  if (crypto.timingSafeEqual(a, b)) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}
