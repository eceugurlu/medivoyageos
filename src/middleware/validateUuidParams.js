// Every :id in a panel/portal route is a Postgres UUID column. Without this,
// a malformed one reached the query and Postgres rejected it — which the
// route wrapper turned into `500 {"error":"invalid input syntax for type
// uuid: \"not-a-uuid\""}`. That is wrong twice over: a bad id in the URL is
// the caller's error (400), not the server's, and the raw driver message
// tells a stranger what database sits behind the endpoint.
//
// It is also not merely cosmetic: healthMonitor.js counts server-side
// failures, so a scanner walking /api/conversations/<junk> could drive a
// "the system is failing" alert out of traffic that never had a chance of
// succeeding.
//
// Registered with router.param() rather than checked per handler, so this
// cannot be forgotten on a route added later — any route that declares one
// of these names is covered the moment it exists.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deliberately NOT including `token` (quote/itinerary view tokens are random
// hex, not UUIDs) — those routes are public-by-token and validate by lookup.
export const UUID_PARAMS = [
  'appointmentId', 'branchId', 'coordinatorId', 'costId', 'deviceId', 'doctorId',
  'leadId', 'messageId', 'noteId', 'partnerId', 'paymentId', 'quoteId',
];

export function guardUuidParams(router, names = UUID_PARAMS) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => {
      if (UUID_RE.test(value)) return next();
      res.status(400).json({ error: `Invalid ${name}` });
    });
  }
}
