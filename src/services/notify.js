import { config } from '../config.js';

export const notifyEnabled = Boolean(config.notify.webhookUrl);

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
    `Patient: ${name || 'Unknown'} (${phone})\n` +
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
    `Patient: ${name || 'Unknown'} (${phone})\n` +
    (language ? `Language: ${language}\n` : '') +
    (daysUntil != null ? `Scheduled in: ${daysUntil} day(s)\n` : '') +
    (why ? `Why:\n${why}` : '');

  try {
    const res = await fetch(config.notify.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error(`[notify] risk webhook returned ${res.status}`);
    else console.log(`[notify] no-show risk pinged for ${phone} (${score}/100)`);
  } catch (err) {
    console.error('[notify] risk webhook failed (non-fatal):', err.message);
  }
}
