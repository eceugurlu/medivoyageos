// Instagram DM + Facebook Messenger sends. Both platforms share Meta's Send
// API (POST /me/messages) — same shape, same access token when Instagram is
// connected to the sending Page, which is the standard setup. Kept as its
// own file (not folded into whatsapp.js) because these are genuinely
// different Graph API products, even though the JS here looks similar.
import { config } from '../config.js';

export const metaMessagingEnabled = Boolean(config.meta.pageAccessToken);

// Same reasoning as whatsapp.js's HTTP_TIMEOUT_MS — one shared 30s Vercel
// function budget for every route, so a hung Graph API call needs to throw
// on its own rather than rely on the platform's blunt kill.
const HTTP_TIMEOUT_MS = 8_000;

async function sendViaMetaSendApi(recipientId, text, channelLabel) {
  if (!metaMessagingEnabled) {
    console.log(`[${channelLabel}:dry-run] would send → ${recipientId}: ${text}`);
    return { dryRun: true };
  }

  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/me/messages?access_token=${encodeURIComponent(config.meta.pageAccessToken)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[${channelLabel}] send failed`, res.status, JSON.stringify(data));
    throw new Error(`${channelLabel} send failed: ${res.status}`);
  }
  return data;
}

/**
 * Show the "typing…" bubble on Instagram/Messenger while the concierge thinks.
 * Same purpose and same best-effort contract as whatsapp.js's
 * sendTypingIndicator — see the reasoning there. These platforms use the Send
 * API's sender_actions rather than WhatsApp's typing_indicator field, and the
 * indicator clears itself when the reply arrives.
 */
export async function sendTypingAction(recipientId, channelLabel = 'messenger') {
  if (!metaMessagingEnabled || !recipientId) return { skipped: true };
  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/me/messages?access_token=${encodeURIComponent(config.meta.pageAccessToken)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: 'typing_on' }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn(`[${channelLabel}] typing action failed`, res.status, JSON.stringify(data).slice(0, 200));
    }
  } catch (err) {
    console.warn(`[${channelLabel}] typing action error:`, err.message);
  }
  return { ok: true };
}

/** Reply to an Instagram DM. recipientId is the sender's IGSID from the webhook. */
export async function sendInstagramText(igsid, text) {
  return sendViaMetaSendApi(igsid, text, 'instagram');
}

/** Reply to a Messenger conversation. recipientId is the sender's PSID from the webhook. */
export async function sendMessengerText(psid, text) {
  return sendViaMetaSendApi(psid, text, 'messenger');
}
