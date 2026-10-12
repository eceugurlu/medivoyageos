import { config } from '../config.js';

// Zoho sync only runs when all three OAuth values are present — otherwise it's a
// no-op, exactly like the AI/DB/WhatsApp feature flags. So the app runs fine
// with Zoho unconfigured, and lights up the moment you fill in the .env values.
export const zohoEnabled = Boolean(
  config.zoho.clientId && config.zoho.clientSecret && config.zoho.refreshToken,
);

// Same reasoning as whatsapp.js's HTTP_TIMEOUT_MS (shared 30s Vercel function
// budget for every route) — a hung Zoho call needs to throw on its own
// rather than rely on the platform's blunt kill. Zoho sync already runs
// best-effort/non-fatal (see webhook.js), so this just makes "it failed"
// arrive promptly instead of stalling the invocation.
const HTTP_TIMEOUT_MS = 15_000;

// ── OAuth token manager ────────────────────────────────────────────────────
// Zoho access tokens expire in ~1 hour. We cache one in memory and refresh it
// with the long-lived refresh_token when it's missing or about to expire.
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }
  const params = new URLSearchParams({
    refresh_token: config.zoho.refreshToken,
    client_id: config.zoho.clientId,
    client_secret: config.zoho.clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${config.zoho.accountsHost}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Zoho token refresh failed: ${res.status} ${JSON.stringify(data)}`);
  }
  const ttlMs = (data.expires_in ? Number(data.expires_in) : 3600) * 1000;
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + ttlMs };
  return cachedToken.accessToken;
}

// Fetch with the Zoho token injected. On a 401 (token revoked server-side),
// clear the cache, refresh once, and retry.
async function authedFetch(url, options = {}) {
  let token = await getAccessToken();
  const withAuth = (t) => ({
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Zoho-oauthtoken ${t}` },
    signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  let res = await fetch(url, withAuth(token));
  if (res.status === 401) {
    cachedToken = null;
    token = await getAccessToken();
    res = await fetch(url, withAuth(token));
  }
  return res;
}

// ── Field mapping ───────────────────────────────────────────────────────────
// Internal lead status → Zoho "Lead_Status" picklist value.
// ⚠️ These strings MUST exist in your Zoho org's Lead Status picklist.
// Rename them to match your pipeline (e.g. 'Sıcak Lead' → 'Teklif Gönderildi'
// → 'Depozito Alındı'). If a value isn't in your picklist, the sync detects the
// rejection and retries WITHOUT the status, so the lead is never lost.
const STAGE_MAP = {
  new: 'Not Contacted',
  hot: 'Contacted',
  handed_over: 'Contacted',
  booked: 'Pre-Qualified',
  lost: 'Lost Lead',
};

function splitName(name) {
  // Zoho requires Last_Name. Fall back to a placeholder when we don't know it
  // yet (the AI usually fills this in from a later message) — channel-neutral,
  // since this lead may have come from WhatsApp, Instagram, or Messenger.
  if (!name) return { first: null, last: 'New Lead' };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { first: null, last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// Zoho's Upsert API dedupes on Phone, which must be a non-null, unique value.
// WhatsApp/widget leads have a real phone; Instagram/Messenger leads don't
// (see migration 020_multichannel.sql — leads.phone is nullable there). A
// null Phone on the upsert call would either be rejected or, worse, silently
// match/merge into some OTHER lead that also has a blank Phone in Zoho — so
// social leads get a synthetic-but-stable, human-readable surrogate instead,
// keeping the same single upsert-by-Phone path safe for every channel.
function leadIdentifier(lead) {
  if (lead.phone) return lead.phone;
  if (lead.external_id) return `${lead.source || 'social'}:${lead.external_id}`;
  return null;
}

// Rich data (language, treatment, budget, score, latest exchange) goes into the
// standard Description field so this works on a fresh Zoho org WITHOUT requiring
// you to create custom fields first. Map to custom fields later if you want them
// as columns (see README notes).
function buildDescription(lead, extra) {
  return [
    lead.language ? `Language: ${lead.language}` : null,
    lead.treatment_interest ? `Treatment: ${lead.treatment_interest}` : null,
    lead.budget_hint ? `Budget: ${lead.budget_hint}` : null,
    lead.readiness ? `Readiness: ${lead.readiness}` : null,
    Number.isFinite(lead.score) ? `Lead score: ${lead.score}/100` : null,
    lead.status ? `Internal stage: ${lead.status}` : null,
    extra?.lastUserText ? `\nLast patient message: ${extra.lastUserText}` : null,
    extra?.lastReply ? `AI reply: ${extra.lastReply}` : null,
    `\n— synced from MediVoyage OS`,
  ]
    .filter(Boolean)
    .join('\n');
}

function toZohoRecord(lead, extra, { withStatus = true } = {}) {
  const { first, last } = splitName(lead.name);
  const identifier = leadIdentifier(lead);
  if (!identifier) throw new Error(`lead ${lead.id} has neither phone nor external_id — refusing to upsert with a blank dedupe key`);
  const rec = {
    Last_Name: last,
    Phone: identifier,
    Description: buildDescription(lead, extra),
  };
  if (first) rec.First_Name = first;
  if (lead.country) rec.Country = lead.country;
  if (withStatus && lead.status && STAGE_MAP[lead.status]) {
    rec.Lead_Status = STAGE_MAP[lead.status];
  }
  return rec;
}

// ── Upsert (create-or-update by phone) ───────────────────────────────────────
// Zoho's Upsert API does insert-or-update in a single atomic call based on a
// duplicate-check field — cleaner and safer than COQL-search-then-POST/PUT.
async function upsertOnce(record) {
  const res = await authedFetch(`${config.zoho.apiHost}/crm/v2/Leads/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [record], duplicate_check_fields: ['Phone'] }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function isRowError(row) {
  return row?.status === 'error' || (row?.code && row.code !== 'SUCCESS');
}

/**
 * Sync one lead to Zoho CRM. Returns the Zoho record id (or null).
 * Designed to never take down the conversation: expected CRM problems throw a
 * clean Error that the caller logs and swallows.
 *
 * @param {object} lead  a row from our `leads` table
 * @param {{lastUserText?:string, lastReply?:string}} extra
 */
export async function syncLeadToCrm(lead, extra = {}) {
  if (!zohoEnabled) return null;

  let record = toZohoRecord(lead, extra, { withStatus: true });
  let { ok, status, data } = await upsertOnce(record);
  let row = data?.data?.[0];

  // Classic Zoho gotcha: the Lead_Status value isn't in the org's picklist.
  // Detect it and retry without the status so the lead still lands.
  const statusRejected =
    isRowError(row) && /status/i.test(JSON.stringify(row?.details || row?.message || ''));
  if ((!ok || isRowError(row)) && statusRejected && record.Lead_Status) {
    console.warn(
      `[zoho] Lead_Status "${record.Lead_Status}" not in your org's picklist — ` +
        `retrying without it. Edit STAGE_MAP in src/services/zoho.js to match your pipeline.`,
    );
    record = toZohoRecord(lead, extra, { withStatus: false });
    ({ ok, status, data } = await upsertOnce(record));
    row = data?.data?.[0];
  }

  if (!ok || isRowError(row)) {
    throw new Error(`Zoho upsert failed: HTTP ${status} ${JSON.stringify(data)}`);
  }

  const id = row?.details?.id || null;
  const action = row?.action || 'upserted';
  console.log(`[zoho] lead ${action} → id ${id} (${leadIdentifier(lead)})`);
  return id;
}
