import { config } from '../config.js';

export const notifyEnabled = Boolean(config.notify.webhookUrl);

// Same reasoning as whatsapp.js's HTTP_TIMEOUT_MS (shared 30s Vercel function
// budget for every route) — these calls are already non-fatal/best-effort,
// but without a timeout a hung webhook would leave the promise dangling
// until the whole invocation is killed rather than resolving (and logging)
// cleanly on its own.
const HTTP_TIMEOUT_MS = 8_000;

/**
 * Ping an external webhook (Slack-compatible: expects JSON { text }) when a
 * patient conversation needs a human. Best-effort — never throws to the caller,
 * so a notification failure can't affect the conversation. When no webhook is
 * configured this is a no-op; the handover still shows in the panel's queue.
 */
export async function notifyHandover({ name, phone, reason, urgent, medicalNote, score, language, treatment }) {
  if (!notifyEnabled) return;

  const text =
    (urgent ? `🚑 *URGENT — medical escalation*\n` : `🔔 *New handover needed*\n`) +
    `Patient: ${name || 'Unknown'}${phone ? ` (${phone})` : ''}\n` +
    (language ? `Language: ${language}\n` : '') +
    (treatment ? `Treatment: ${treatment}\n` : '') +
    (medicalNote ? `Clinical note: ${medicalNote}\n` : '') +
    (Number.isFinite(score) ? `Lead score: ${score}/100\n` : '') +
    `Reason: ${reason || 'unspecified'}`;

  try {
    const res = await fetch(config.notify.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`[notify] webhook returned ${res.status}`);
    else console.log(`[notify] handover pinged for ${phone}`);
  } catch (err) {
    console.error('[notify] webhook failed (non-fatal):', err.message);
  }
}


/**
 * Ping the same webhook when a patient crosses the no-show risk threshold.
 * Deliberately carries the *reasons*, not just the number — a coordinator
 * reading this in Slack should be able to judge it without opening the panel,
 * and disagree with it if the rules got it wrong. Best-effort like
 * notifyHandover: never throws, no-op when no webhook is configured.
 */
export async function notifyNoShowRisk({ name, phone, score, reasons, daysUntil, language }) {
  if (!notifyEnabled) return;

  const why = (reasons || [])
    .map((r) => `• ${r.factor}${r.detail ? ` (${r.detail})` : ''} +${r.points}`)
    .join('\n');

  const text =
    `⚠️ *No-show risk: ${score}/100*\n` +
    `Patient: ${name || 'Unknown'}${phone ? ` (${phone})` : ''}\n` +
    (language ? `Language: ${language}\n` : '') +
    (daysUntil != null ? `Scheduled in: ${daysUntil} day(s)\n` : '') +
    (why ? `Why:\n${why}` : '');

  try {
    const res = await fetch(config.notify.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`[notify] risk webhook returned ${res.status}`);
    else console.log(`[notify] no-show risk pinged for ${phone} (${score}/100)`);
  } catch (err) {
    console.error('[notify] risk webhook failed (non-fatal):', err.message);
  }
}

/**
 * Ping the same webhook the moment Stripe confirms a deposit/payment — the
 * one event in this app that means real money actually moved, so it's worth
 * a push even to a team that otherwise only checks the panel once an hour.
 */
export async function notifyPaymentReceived({ name, phone, amount, currency, type }) {
  if (!notifyEnabled) return;

  const text =
    `💳 *Payment received: ${currency} ${Number(amount).toLocaleString()}*\n` +
    `Patient: ${name || 'Unknown'}${phone ? ` (${phone})` : ''}\n` +
    `Type: ${type || 'deposit'}`;

  try {
    const res = await fetch(config.notify.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`[notify] payment webhook returned ${res.status}`);
    else console.log(`[notify] payment received pinged (${currency} ${amount})`);
  } catch (err) {
    console.error('[notify] payment webhook failed (non-fatal):', err.message);
  }
}
