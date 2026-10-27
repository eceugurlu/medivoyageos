import { config } from '../config.js';

export const notifyEnabled = Boolean(config.notify.webhookUrl);
// A separate, OPTIONAL channel for engineering/ops alerts (AI outage, webhook
// processing failures, uncaught exceptions) — a clinic coordinator doesn't
// need "the AI concierge is down" showing up in the same place as "a patient
// needs you". Falls back to the same webhookUrl when no dedicated one is
// set, so nothing is silently dropped just because a second webhook wasn't configured.
export const systemAlertEnabled = Boolean(config.notify.systemAlertWebhookUrl);

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

const SEVERITY_EMOJI = { critical: '🔥', warning: '⚠️', ok: '✅' };

/**
 * Engineering/ops alert — AI outage, a webhook that failed to process a real
 * event, an uncaught exception. See src/services/healthMonitor.js for the
 * repeating-failure/cooldown logic that calls this for the AI-outage case;
 * routes/stripeWebhook.js and routes/iyzicoWebhook.js call it directly, once
 * per failed payment confirmation, with no cooldown — each one is its own
 * patient's money and deserves its own alert, not to be swallowed by a
 * cooldown meant for "the same recoverable blip repeating".
 */
export async function notifySystemAlert({ severity = 'warning', title, detail, consecutiveFailures }) {
  if (!systemAlertEnabled) return;

  const text =
    `${SEVERITY_EMOJI[severity] || '⚠️'} *${title}*\n` +
    (Number.isFinite(consecutiveFailures) ? `Consecutive failures: ${consecutiveFailures}\n` : '') +
    (detail ? `Detail: ${detail}` : '');

  try {
    const res = await fetch(config.notify.systemAlertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`[notify] system-alert webhook returned ${res.status}`);
    else console.log(`[notify] system alert pinged: ${title}`);
  } catch (err) {
    // Deliberately just logged, never re-thrown — a monitoring ping failing
    // must never be what takes down the thing it was trying to report on.
    console.error('[notify] system-alert webhook failed (non-fatal):', err.message);
  }
}

// Monday's report is a business summary, not an urgent alert — a SEPARATE
// optional channel from the handover webhook so a clinic owner's weekly
// digest doesn't get buried between individual patient pings, or vice versa.
// Falls back to the same webhookUrl when unset, same "never silently drop
// it for lack of a second webhook" reasoning as every other optional channel
// in this file.
export const weeklyReportEnabled = Boolean(config.notify.weeklyReportWebhookUrl);

function formatDuration(totalSeconds) {
  if (totalSeconds == null) return 'n/a (no replied messages this week)';
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 1) return `${totalSeconds}s`;
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} hr`;
}

/**
 * Monday's automatic weekly summary — see repository.js::getWeeklyReportStats()
 * for exactly what each figure means and its known approximations (stated
 * there, not hidden). Best-effort like every other notify* function: never
 * throws, no-op when no webhook is configured.
 */
export async function notifyWeeklyReport(stats) {
  if (!weeklyReportEnabled) return;

  const periodLabel = `${new Date(stats.period.start).toLocaleDateString('en-GB')} – ${new Date(stats.period.end).toLocaleDateString('en-GB')}`;
  const text =
    `📊 *Weekly report — ${periodLabel}*\n\n` +
    `New leads: ${stats.new_leads}\n` +
    `Qualified (hot/handed over/booked): ${stats.qualified_leads}\n` +
    `Currently hot: ${stats.hot_leads}\n` +
    `Appointments booked: ${stats.appointments_booked}\n` +
    `Deposits collected: €${stats.deposits_collected_eur.toLocaleString()}\n` +
    `Avg. reply time: ${formatDuration(stats.avg_response_seconds)}` +
    (stats.replied_turns ? ` (over ${stats.replied_turns} replies)` : '') + `\n` +
    `⏳ Waiting for a human right now: ${stats.missed_conversations_now}`;

  try {
    const res = await fetch(config.notify.weeklyReportWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`[notify] weekly-report webhook returned ${res.status}`);
    else console.log(`[notify] weekly report sent for ${periodLabel}`);
  } catch (err) {
    console.error('[notify] weekly-report webhook failed (non-fatal):', err.message);
  }
}

/**
 * Devir SLA Alarmı, first tier: a handover has sat unanswered in the Action
 * Center queue past HANDOVER_SLA_FIRST_REMINDER_MINUTES. Names the assigned
 * coordinator in the message when one is known — there's no per-person
 * notification channel in this app yet, so naming them in the ONE shared
 * webhook is what actually makes this reminder, rather than another generic
 * handover ping. minutesWaiting is passed in rather than recomputed here so
 * the caller's own "now - escalated_at" stays the single source of truth.
 */
export async function notifySlaFirstReminder({ name, phone, reason, urgent, score, language, coordinatorName, minutesWaiting }) {
  if (!notifyEnabled) return;

  const text =
    `⏰ *Handover waiting ${minutesWaiting} min — still unanswered*\n` +
    `Patient: ${name || 'Unknown'}${phone ? ` (${phone})` : ''}\n` +
    (coordinatorName ? `Assigned to: ${coordinatorName}\n` : 'Assigned to: (no coordinator matched)\n') +
    (language ? `Language: ${language}\n` : '') +
    (Number.isFinite(score) ? `Lead score: ${score}/100\n` : '') +
    (urgent ? `⚠️ Originally flagged URGENT\n` : '') +
    `Reason: ${reason || 'unspecified'}`;

  try {
    const res = await fetch(config.notify.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`[notify] sla-reminder webhook returned ${res.status}`);
    else console.log(`[notify] SLA first reminder pinged for ${phone} (waiting ${minutesWaiting}m)`);
  } catch (err) {
    console.error('[notify] sla-reminder webhook failed (non-fatal):', err.message);
  }
}

/**
 * Devir SLA Alarmı, second tier: STILL unanswered past
 * HANDOVER_SLA_ESCALATE_MINUTES, after the first reminder already fired.
 * Goes to config.notify.managerWebhookUrl — a separate, more visible channel
 * when one is configured, or the same one as above (clearly re-labeled)
 * otherwise, so this is never silently skipped for lack of a second webhook.
 */
export async function notifySlaEscalation({ name, phone, reason, urgent, score, language, coordinatorName, minutesWaiting }) {
  if (!config.notify.managerWebhookUrl) return;

  const text =
    `🆘 *ESCALATED — handover unanswered for ${minutesWaiting} min*\n` +
    `Patient: ${name || 'Unknown'}${phone ? ` (${phone})` : ''}\n` +
    (coordinatorName ? `Was assigned to: ${coordinatorName} (no response)\n` : 'No coordinator matched\n') +
    (language ? `Language: ${language}\n` : '') +
    (Number.isFinite(score) ? `Lead score: ${score}/100\n` : '') +
    (urgent ? `⚠️ Originally flagged URGENT\n` : '') +
    `Reason: ${reason || 'unspecified'}`;

  try {
    const res = await fetch(config.notify.managerWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`[notify] sla-escalation webhook returned ${res.status}`);
    else console.log(`[notify] SLA escalation pinged for ${phone} (waiting ${minutesWaiting}m)`);
  } catch (err) {
    console.error('[notify] sla-escalation webhook failed (non-fatal):', err.message);
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
