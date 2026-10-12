import express from 'express';
import { config, aiEnabled, sendEnabled, isProduction } from './config.js';
import { dbEnabled } from './db/pool.js';
import { zohoEnabled } from './services/zoho.js';
import { checkAccessToken } from './services/whatsapp.js';
import { webhookRouter } from './routes/webhook.js';
import { stripeWebhookRouter } from './routes/stripeWebhook.js';
import { iyzicoWebhookRouter } from './routes/iyzicoWebhook.js';
import { apiRouter, publicRouter } from './routes/api.js';
import { partnerRouter } from './routes/partner.js';
import { doctorRouter } from './routes/doctor.js';

// The Express app itself — no app.listen(), no schedulers, no seeding. Shared
// by the local dev entry (src/server.js) and the Vercel serverless entry
// (api/index.js), which each wrap it differently: one long-running process
// with setInterval timers, one stateless function per request with cron
// routes standing in for those timers (see src/services/scheduler.js).
export const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
// İyzico's Checkout Form callback POSTs application/x-www-form-urlencoded
// (just a `token` field), not JSON — express.json() above silently ignores
// non-JSON bodies, so this is needed alongside it, not instead of it.
app.use(express.urlencoded({ extended: true }));

// The two verifiers below fail CLOSED in production (see verifySignature.js and
// stripeWebhook.js). That is the right default, but it turns a missing env var
// into "deliveries are silently refused" — so the same condition is reported
// here, where it can be read in one request instead of guessed at from logs.
function configWarnings() {
  const w = [];
  if (isProduction && !config.whatsapp.appSecret) {
    w.push('WHATSAPP_APP_SECRET is not set — all incoming Meta webhooks (WhatsApp, Instagram, Messenger) are being REJECTED.');
  }
  if (isProduction && !config.stripe.webhookSecret) {
    w.push('STRIPE_WEBHOOK_SECRET is not set — incoming Stripe payment webhooks are being REJECTED.');
  }
  if (config.whatsapp.verifyToken === 'change-me') {
    w.push('WHATSAPP_VERIFY_TOKEN is still the default "change-me".');
  }
  return w;
}

app.get('/health', async (_req, res) => {
  const warnings = configWarnings();
  // `whatsapp: true` only ever meant "the env vars are set". Meta's free test
  // number issues 24-hour tokens, so the common real state is configured-but-
  // expired, which looked identical here and silently stopped every reply.
  const token = await checkAccessToken();
  if (token.ok === false) {
    warnings.push(`WHATSAPP_ACCESS_TOKEN is no longer valid (${token.detail}) — patients are not receiving replies. Generate a new token in the Meta dashboard and update the env var.`);
  }
  res.json({
    ok: warnings.length === 0,
    ai: aiEnabled,
    whatsapp: sendEnabled,
    whatsappToken: token.ok === null ? 'unknown' : token.ok ? 'valid' : 'expired',
    db: dbEnabled,
    zoho: zohoEnabled,
    warnings,
  });
});

app.use('/webhook', webhookRouter);
app.use('/webhooks/stripe', stripeWebhookRouter);
app.use('/webhooks/iyzico', iyzicoWebhookRouter);
app.use('/api/public', publicRouter); // unauthenticated widget endpoint (mounted first)
app.use('/api/partner', partnerRouter); // partner's own token, not PANEL_API_TOKEN (mounted before apiRouter)
app.use('/api/doctor', doctorRouter); // doctor's own token, not PANEL_API_TOKEN (mounted before apiRouter)
app.use('/api', apiRouter);

// Serve the management panel (static, no build step) at /panel.
app.use('/panel', express.static('public'));

// Unknown /api path → JSON. Express's default is an HTML error page, which the
// panel's api() helper cannot parse, so a typo'd route surfaced as a confusing
// "Unexpected token <" instead of a clear 404.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));

// Last-resort error handler. Catches what the route wrappers miss — most often a
// malformed JSON body rejected by express.json() — and answers in JSON too.
app.use((err, _req, res, _next) => {
  console.error('[http]', err.message);
  if (res.headersSent) return;
  res.status(err.status || err.statusCode || 500).json({ error: err.message || 'Internal error' });
});
