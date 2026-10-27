// Best-effort rate limiting for the ONE unauthenticated, cross-origin write
// in this app: POST /api/public/lead (the embeddable widget). Field sizes are
// already clamped there, but nothing capped how OFTEN a caller could submit —
// and createWidgetLead() upserts the lead/conversation while inserting the
// message unconditionally, so repeated posts with a single phone number append
// unbounded rows to one patient thread and bury the coordinator's inbox.
//
// Honest about what this is NOT:
//   - Not a security boundary. The key is the caller's apparent IP, and a
//     determined attacker can rotate X-Forwarded-For or source addresses.
//     It stops naive floods and broken retry loops, and raises the cost of
//     the rest; it does not make abuse impossible.
//   - Not exact on serverless. The counters live in this instance's memory,
//     so Vercel running several instances multiplies the effective ceiling.
//     An exact global limit needs a shared store (a Postgres counter or
//     Redis); that is a deliberate trade, not an oversight — this keeps the
//     hot path free of an extra round-trip per request.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20; // a real person submits the form once or twice; carrier-NAT shares an IP, so leave headroom

const hits = new Map(); // key → { count, resetAt }

// Vercel terminates TLS in front of the function, so req.ip is the proxy
// unless `trust proxy` is set — every visitor would then share one bucket and
// the first flood would lock out every real patient. Read the forwarded chain
// directly instead, and fall back to the socket address locally.
function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function rateLimit({ windowMs = WINDOW_MS, max = MAX_REQUESTS } = {}) {
  return function limiter(req, res, next) {
    const now = Date.now();
    const key = clientKey(req);
    const entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      // Opportunistic sweep: without it the Map is an unbounded leak in the
      // long-lived local process (on serverless the instance dies anyway).
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
      }
      return next();
    }

    entry.count++;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests — please try again later.' });
    }
    return next();
  };
}
