import 'dotenv/config';

// We warn (not throw) on missing values so the server can still boot in
// "dry-run / echo" mode. That lets you test the WhatsApp plumbing before you
// have every credential in place.
function softRequire(name, value) {
  if (!value) console.warn(`[config] ${name} not set — that feature runs in limited mode.`);
  return value;
}

// True on a real production deployment. The "missing secret → skip the check"
// convention below is a deliberate local-dev convenience, but on a public URL
// it silently turns an authentication step into no authentication at all, so
// the webhook verifiers use this to fail CLOSED there instead.
export const isProduction =
  process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

export const config = {
  port: process.env.PORT || 3000,

  // The URL other systems (WhatsApp's servers fetching a quote PDF, a patient
  // clicking a tracking link) use to reach this server. Explicit PUBLIC_BASE_URL
  // wins; on Vercel, VERCEL_PROJECT_PRODUCTION_URL (stable across deploys) is
  // used automatically so this never needs setting by hand there. Falls back
  // to localhost for local dev — fine since dry-run mode never actually fetches it.
  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
    || (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`)
    || `http://localhost:${process.env.PORT || 3000}`
  ).replace(/\/$/, ''),

  whatsapp: {
    // A random string you choose. Put the SAME value into the Meta webhook config.
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'change-me',
    accessToken: softRequire('WHATSAPP_ACCESS_TOKEN', process.env.WHATSAPP_ACCESS_TOKEN),
    phoneNumberId: softRequire('WHATSAPP_PHONE_NUMBER_ID', process.env.WHATSAPP_PHONE_NUMBER_ID),
    // Match the version shown in your Meta App Dashboard (e.g. v21.0).
    graphVersion: process.env.GRAPH_API_VERSION || 'v21.0',
    // Optional. When set, incoming webhook signatures are verified.
    appSecret: process.env.WHATSAPP_APP_SECRET || null,
  },

  anthropic: {
    // Leave blank to run in echo mode (no AI). Add it to turn the concierge on.
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 1024),
  },

  openai: {
    // Leave blank to disable voice-message transcription — a patient's voice
    // note still reaches the panel, just untranscribed (see webhook.js).
    apiKey: process.env.OPENAI_API_KEY || null,
  },

  // Instagram DM + Facebook Messenger. Both ride the SAME Meta App and the
  // same /webhook callback URL/verify token as WhatsApp above (Meta lets one
  // app subscribe to whatsapp_business_account, instagram, and page products
  // on one callback) — only the Page Access Token is new. One token covers
  // both when Instagram is connected to that Page, which is the normal setup.
  meta: {
    pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || null,
  },

  // One-click international deposit/payment links. Leave blank to run in
  // dry-run mode: a link is still "created" (a fake local URL) and "sent"
  // through the patient's channel so the whole flow is testable end-to-end
  // before the clinic's real Stripe account is connected.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    // Signs incoming webhook events (see routes/stripeWebhook.js). Optional
    // like WHATSAPP_APP_SECRET — recommended in production, skippable while
    // testing — but unlike a WhatsApp message, a forged "payment received"
    // event here would mark a deposit paid that never happened, so set this
    // before connecting a live Stripe key.
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
  },
  // (warned about below, once both stripe values above are known) — a live
  // key with no webhook secret means /webhooks/stripe accepts ANY POST body
  // as a genuine payment confirmation, unsigned.

  // İyzico — the second deposit-link provider, alongside Stripe. A Turkish
  // clinic entity typically can't even open a Stripe account directly (Stripe
  // doesn't operate merchant accounts in Turkey), so for many clinics this is
  // the one that actually processes real charges, with Stripe covering
  // currencies/markets İyzico doesn't. Leave blank to dry-run like Stripe does.
  iyzico: {
    apiKey: process.env.IYZICO_API_KEY || null,
    secretKey: process.env.IYZICO_SECRET_KEY || null,
    // Production host by default; point at sandbox-api.iyzipay.com while
    // testing with sandbox credentials (İyzico uses a different HOST for
    // sandbox, unlike Stripe where test/live is just a key prefix).
    baseUrl: process.env.IYZICO_BASE_URL || 'https://api.iyzipay.com',
  },

  db: {
    // Leave blank to run with the temporary in-memory store (dev/testing only —
    // history resets on restart, nothing survives, nothing feeds the panel or Zoho).
    url: process.env.DATABASE_URL || null,
  },

  zoho: {
    // Self Client OAuth. Leave blank to disable CRM sync (app still runs).
    clientId: process.env.ZOHO_CLIENT_ID || null,
    clientSecret: process.env.ZOHO_CLIENT_SECRET || null,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN || null,
    // Region hosts — change for your Zoho data center:
    //   EU  → accounts.zoho.eu       / www.zohoapis.eu
    //   IN  → accounts.zoho.in       / www.zohoapis.in
    //   AU  → accounts.zoho.com.au   / www.zohoapis.com.au
    accountsHost: process.env.ZOHO_ACCOUNTS_HOST || 'https://accounts.zoho.com',
    apiHost: process.env.ZOHO_API_HOST || 'https://www.zohoapis.com',
  },

  notify: {
    // Optional: a Slack (or any) incoming webhook URL to ping on new handovers.
    // Leave blank to rely on the panel's Action Center queue instead.
    webhookUrl: process.env.HANDOVER_WEBHOOK_URL || null,
    // Devir SLA Alarmı — a SEPARATE, more visible webhook (e.g. a manager's
    // own Slack channel) for the second-tier "still unanswered" escalation.
    // Leave blank to reuse the same webhookUrl above for both tiers — the
    // escalation message is still clearly labeled as a repeat/escalated
    // alert in that case, so nothing is silently missed either way.
    managerWebhookUrl: process.env.HANDOVER_SLA_MANAGER_WEBHOOK_URL || process.env.HANDOVER_WEBHOOK_URL || null,
    // How long an unanswered handover sits in the Action Center queue before
    // each tier fires. The escalate threshold must be checked to be at least
    // past the first-reminder one — see the warning below.
    slaFirstReminderMinutes: Number(process.env.HANDOVER_SLA_FIRST_REMINDER_MINUTES || 10),
    slaEscalateMinutes: Number(process.env.HANDOVER_SLA_ESCALATE_MINUTES || 30),
    // Optional, SEPARATE webhook for the automatic Monday business summary
    // (see services/notify.js::notifyWeeklyReport) — falls back to the same
    // webhookUrl above when unset, so it's never silently skipped for lack
    // of a dedicated second webhook.
    weeklyReportWebhookUrl: process.env.WEEKLY_REPORT_WEBHOOK_URL || process.env.HANDOVER_WEBHOOK_URL || null,
    // Optional, SEPARATE webhook for engineering/ops alerts (AI outage,
    // payment-webhook processing failures, uncaught exceptions) — a clinic
    // coordinator's channel ideally shouldn't fill up with "the AI is down"
    // noise. Falls back to the SAME webhookUrl above when unset, same
    // reasoning as the SLA alarm's managerWebhookUrl: the point of this
    // feature is catching failures nobody would otherwise notice, so a team
    // that hasn't gotten around to setting up a second webhook still gets
    // the alert (just mixed into the one channel they do have) rather than
    // silently getting none at all.
    systemAlertWebhookUrl: process.env.SYSTEM_ALERT_WEBHOOK_URL || process.env.HANDOVER_WEBHOOK_URL || null,
  },

  panel: {
    // Optional: if set, the /api routes require Authorization: Bearer <token>.
    // Leave blank for easy local testing (open on localhost only in that case).
    apiToken: process.env.PANEL_API_TOKEN || null,
  },

  // Protects the api/cron/*.js routes from being triggered by a random public
  // POST. Vercel sends this as `Authorization: Bearer $CRON_SECRET` on its
  // own scheduled invocations when the env var is set (see vercel.json).
  cronSecret: process.env.CRON_SECRET || null,
};

// Feature flags derived from what's configured.
export const aiEnabled = Boolean(config.anthropic.apiKey);
export const sendEnabled = Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId);

// A live Stripe key with no webhook secret means routes/stripeWebhook.js
// accepts an UNSIGNED POST as a genuine "payment received" — i.e. real money
// treated as collected when none was. Runs on every cold start (both local
// and Vercel), so this can't be missed the way a one-time startup banner line
// could be.
if (config.stripe.secretKey && !config.stripe.webhookSecret) {
  console.warn(
    '[config] STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not — ' +
      '/webhooks/stripe will accept unsigned requests as genuine payment confirmations. ' +
      'Set STRIPE_WEBHOOK_SECRET before relying on this in production.',
  );
}

// A misconfigured pair here would mean the "still unanswered" escalation
// tier fires BEFORE (or at the same time as) the first reminder — defeats
// the whole point of having two tiers, so it's worth a loud warning rather
// than a confusing SLA alert order in Slack.
if (config.notify.slaEscalateMinutes <= config.notify.slaFirstReminderMinutes) {
  console.warn(
    `[config] HANDOVER_SLA_ESCALATE_MINUTES (${config.notify.slaEscalateMinutes}) should be greater than ` +
      `HANDOVER_SLA_FIRST_REMINDER_MINUTES (${config.notify.slaFirstReminderMinutes}) — the manager escalation ` +
      'would otherwise fire before or alongside the first coordinator reminder.',
  );
}