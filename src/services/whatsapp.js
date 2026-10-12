import { config, sendEnabled } from '../config.js';

// Every route in this app (webhook included) shares one 30s Vercel function
// budget (vercel.json's functions.api/index.js.maxDuration) — without an
// explicit timeout, a hung Meta Graph API call would only ever end via that
// blunt platform-level kill, which produces no catchable JS error and so
// skips every try/catch built to handle "the send failed" cleanly. A short
// SDK-level timeout throws in time for those to actually run.
//
// Kept tight (not a generous "surely enough" number) because a voice note
// chains FOUR of these budgets in one invocation — downloadMedia's own two
// fetches, then Whisper, then Claude, then the reply send — and each file's
// timeout being "safely under 30s" on its own doesn't mean their SUM is.
// This still can't fully guarantee the chain fits (a proper fix needs a
// shared deadline threaded through the whole pipeline, not done here) but
// every second trimmed here is a second of real margin for that chain.
const HTTP_TIMEOUT_MS = 8_000;

/**
 * Send a plain text WhatsApp message via the Meta Cloud API.
 * If credentials aren't set, logs the message instead of sending (dry-run),
 * so you can exercise the full receive→reply pipeline without live Meta access.
 */
export async function sendText(to, body) {
  if (!sendEnabled) {
    console.log(`[whatsapp:dry-run] would send → ${to}: ${body}`);
    return { dryRun: true };
  }

  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[whatsapp] send failed', res.status, JSON.stringify(data));
    throw new Error(describeSendFailure(res.status, data));
  }
  return data;
}

// Meta's free test-number token is a 24-hour one. When it lapses, nothing in
// the app looks broken — the env var is still set, so every "is WhatsApp
// configured?" flag stays true — and the only symptom is that patients stop
// getting replies, which is exactly the failure you discover during a demo.
// This asks Meta whether the token actually still works, cached so /health can
// be polled freely without adding a Graph call per request.
let tokenCheck = { at: 0, ok: null, detail: null };
const TOKEN_CHECK_TTL_MS = 5 * 60 * 1000;

export async function checkAccessToken({ force = false } = {}) {
  if (!sendEnabled) return { ok: null, detail: 'not configured' };
  if (!force && tokenCheck.ok !== null && Date.now() - tokenCheck.at < TOKEN_CHECK_TTL_MS) {
    return { ok: tokenCheck.ok, detail: tokenCheck.detail, cached: true };
  }
  try {
    const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}?fields=display_phone_number`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
      signal: AbortSignal.timeout(6_000),
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && !data.error;
    tokenCheck = { at: Date.now(), ok, detail: ok ? data.display_phone_number || 'ok' : data.error?.message || `HTTP ${res.status}` };
  } catch (err) {
    // A network blip is not proof the token is bad, so it is reported as
    // unknown rather than cached as a failure that would then persist for the
    // full TTL and mislabel a working setup as broken.
    return { ok: null, detail: `check failed: ${err.message}` };
  }
  return { ok: tokenCheck.ok, detail: tokenCheck.detail };
}

// Meta's failures reach a coordinator as whatever text we throw, and the two
// that actually happen in practice — an expired token and a recipient outside
// the test number's allow-list — both surfaced as a bare "401", which reads
// like the product is broken rather than like a setup step that lapsed. The
// wording matters: this string is what shows up in the panel toast.
function describeSendFailure(status, data) {
  const code = data?.error?.code;
  const detail = data?.error?.message || `HTTP ${status}`;
  if (code === 190 || status === 401) {
    return 'WhatsApp access token has expired — generate a new one in the Meta dashboard and update WHATSAPP_ACCESS_TOKEN. The message was saved but not delivered.';
  }
  if (code === 131030) {
    return "This number is not on the test number's allowed recipient list — add it in the Meta dashboard first.";
  }
  if (code === 131047 || code === 131051) {
    return 'The 24-hour reply window for this patient has closed — an approved template is required to message them again.';
  }
  return `WhatsApp send failed: ${detail}`;
}

/**
 * Mark the patient's message read and show the "typing…" bubble to them.
 *
 * The concierge takes a few seconds to answer (model call, and longer still
 * for a voice note that has to be transcribed first). Without this the patient
 * stares at a silent thread and cannot tell the difference between "thinking"
 * and "nobody is there" — the single most common reason someone re-sends or
 * gives up. Meta keeps the indicator up for ~25s or until the reply lands,
 * whichever comes first, so it never needs clearing by hand.
 *
 * Deliberately best-effort: this is a cosmetic nicety in front of the real
 * reply, so any failure is logged and swallowed rather than allowed to break
 * the turn. Also deliberately NOT awaited by the caller — the few hundred ms
 * it costs would otherwise be added to every reply's latency, inside the same
 * shared 30s budget the AI call is already competing for.
 *
 * @param {string} messageId the inbound message's wamid
 */
export async function sendTypingIndicator(messageId) {
  if (!sendEnabled || !messageId) return { skipped: true };
  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn('[whatsapp] typing indicator failed', res.status, JSON.stringify(data).slice(0, 200));
    }
  } catch (err) {
    console.warn('[whatsapp] typing indicator error:', err.message);
  }
  return { ok: true };
}

/**
 * Send an APPROVED WhatsApp template message. Templates are the only way to
 * message a patient OUTSIDE the 24-hour customer-service window (re-engagement,
 * reminders, campaigns). The template must be pre-approved in the Meta dashboard;
 * here we just supply its name, language, and body variables ({{1}}, {{2}}, …).
 * Dry-run when credentials aren't set.
 *
 * @param {string} to           recipient in E.164 without '+'
 * @param {string} templateName approved template name
 * @param {string} langCode     template language (e.g. 'en')
 * @param {string[]} variables  ordered values for the body {{1}}, {{2}}, …
 */
export async function sendTemplate(to, templateName, langCode = 'en', variables = []) {
  const components = variables.length
    ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: String(v) })) }]
    : [];

  if (!sendEnabled) {
    console.log(`[whatsapp:dry-run] would send TEMPLATE "${templateName}" → ${to} (vars: ${variables.join(', ') || 'none'})`);
    return { dryRun: true };
  }

  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: langCode },
        ...(components.length ? { components } : {}),
      },
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[whatsapp] template send failed', res.status, JSON.stringify(data));
    throw new Error(describeSendFailure(res.status, data));
  }
  return data;
}

/**
 * Send a document (a quote PDF, in practice) as a WhatsApp message by public
 * link. This only works inside Meta's 24-hour customer-service window — the
 * same constraint sendText has; outside it, use an approved template instead
 * (see sendTemplate). Dry-run when credentials aren't set, same as the rest
 * of this file.
 *
 * @param {string} to        recipient in E.164 without '+'
 * @param {string} url       a URL Meta's servers can fetch the PDF from
 * @param {string} filename  suggested filename on the patient's device
 * @param {string} caption   short message shown alongside the document
 */
export async function sendDocument(to, url, filename, caption) {
  if (!sendEnabled) {
    console.log(`[whatsapp:dry-run] would send DOCUMENT → ${to}: ${filename} (${url})`);
    return { dryRun: true };
  }

  const apiUrl = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'document',
      document: { link: url, filename, caption },
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[whatsapp] document send failed', res.status, JSON.stringify(data));
    throw new Error(describeSendFailure(res.status, data));
  }
  return data;
}

/**
 * Download a WhatsApp-hosted media file (a patient-sent photo, in practice)
 * as a base64 buffer + mime type, so it can be handed to Claude as an image
 * block and stored on the message row. Two-step Graph API dance: resolve the
 * media id to a short-lived CDN url, then fetch that url with the same token
 * — the CDN url itself is unauthenticated but expires in minutes, so it's
 * never persisted, only the bytes it pointed to.
 * Returns null in dry-run (no real Meta credentials — nothing to fetch).
 */
export async function downloadMedia(mediaId, fallbackMimeType = 'application/octet-stream') {
  if (!sendEnabled) {
    console.log(`[whatsapp:dry-run] would download media ${mediaId}`);
    return null;
  }

  const metaUrl = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${mediaId}`;
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta.url) {
    console.error('[whatsapp] media lookup failed', metaRes.status, JSON.stringify(meta));
    throw new Error(`WhatsApp media lookup failed: ${metaRes.status}`);
  }

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!fileRes.ok) throw new Error(`WhatsApp media download failed: ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  return { buffer, mimeType: meta.mime_type || fileRes.headers.get('content-type') || fallbackMimeType };
}
