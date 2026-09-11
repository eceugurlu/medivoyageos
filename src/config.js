import 'dotenv/config';

// We warn (not throw) on missing values so the server can still boot in
// "dry-run / echo" mode. That lets you test the WhatsApp plumbing before you
// have every credential in place.
function softRequire(name, value) {
  if (!value) console.warn(`[config] ${name} not set — that feature runs in limited mode.`);
  return value;
}

export const config = {
  port: process.env.PORT || 3000,

  // The URL other systems (WhatsApp's servers fetching a quote PDF, a patient
  // clicking a tracking link) use to reach this server. Defaults to localhost
  // for local dev — fine there since dry-run mode never actually fetches it,
  // but MUST be set to the real public URL before quotes are sent for real.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),

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
  },

  panel: {
    // Optional: if set, the /api routes require Authorization: Bearer <token>.
    // Leave blank for easy local testing (open on localhost only in that case).
    apiToken: process.env.PANEL_API_TOKEN || null,
  },
};

// Feature flags derived from what's configured.
export const aiEnabled = Boolean(config.anthropic.apiKey);
export const sendEnabled = Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId);