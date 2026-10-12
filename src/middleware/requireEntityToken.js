// Shared bearer/query-token auth for the Doctor and Partner portals. Neither
// has a clinic-staff login (see doctor.js/partner.js) — each entity carries
// its own long-lived token instead, issued once by a coordinator in the
// panel, checked the same way in both places; only the lookup function and
// the property it's attached to on `req` differ.
export function requireEntityToken({ lookup, reqKey, entityLabel }) {
  return async function requireToken(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.query.token || '');
    if (!token) return res.status(401).json({ error: `Missing ${entityLabel} token` });
    try {
      const entity = await lookup(token);
      if (!entity) return res.status(401).json({ error: `Invalid or inactive ${entityLabel} token` });
      req[reqKey] = entity;
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}
