// The periodic jobs the OS needs, extracted so they can be driven two
// different ways:
//   - locally (src/server.js): setInterval, same as before — one long-running
//     process, minute-granularity.
//   - on Vercel (api/cron/*.js): each run is a single stateless invocation
//     triggered by Vercel Cron, since a serverless function can't hold a
//     setInterval open between requests.
//
// Every job below claims a row (an atomic conditional UPDATE) BEFORE acting
// on it, not after. Two overlapping runs of the same job — a slow tick plus
// the next setInterval fire, or local dev racing a Vercel Cron invocation
// against the same database — are a real possibility, not a hypothetical:
// nothing stops both from starting. Claiming first means only one of them
// ever wins a given row, so a patient can't be sent the same WhatsApp
// template twice. See markPostOpSent/markHotFollowupSent/markRiskNotified in
// repository.js for the actual atomic UPDATE.
import { config } from '../config.js';
import { sendTemplate } from './whatsapp.js';
import { notifyNoShowRisk, notifySlaFirstReminder, notifySlaEscalation, notifyWeeklyReport } from './notify.js';
import {
  getDuePostOpTasks, markPostOpSent, getNoShowRisks, markRiskNotified, clearRiskNotified,
  getSilentHotLeads, markHotFollowupSent, recordAgentMessage,
  getHandoversNeedingFirstReminder, markSlaFirstReminderSent,
  getHandoversNeedingEscalation, markSlaEscalated,
  claimWeeklyReportSlot, getWeeklyReportStats,
  claimPendingConversionEvents, markConversionEventResult, expireExhaustedConversionEvents,
} from '../store/repository.js';
import {
  buildMessagingEvent, sendEvents, isCapiConfigured, isPermanentFailure,
  CAPI_BATCH_SIZE, CAPI_MAX_ATTEMPTS,
} from './metaCapi.js';

// Guards against the same job overlapping itself specifically (belt-and-
// braces on top of the per-row claim above) — if one run is still going
// when the next setInterval tick fires, the tick is skipped rather than
// starting a second pass over the same candidate rows.
function guarded(name, fn) {
  let running = false;
  return async (...args) => {
    if (running) {
      console.log(`[${name}] previous run still in progress, skipping this tick`);
      return 0;
    }
    running = true;
    try {
      return await fn(...args);
    } finally {
      running = false;
    }
  };
}

// Post-op follow-ups: thank-you, review request, day-7/30 check-in, fit-to-fly,
// 1-year checkup — sent as WhatsApp templates once their due time arrives.
async function _processPostOp() {
  const due = await getDuePostOpTasks();
  let sent = 0;
  for (const t of due) {
    const claimed = await markPostOpSent(t.id).catch((e) => { console.error('[post-op] claim failed:', e.message); return false; });
    if (!claimed) continue; // another run already has this one
    try {
      await sendTemplate(t.phone, t.kind, t.language || 'en', [t.name || 'there']);
      console.log(`[post-op] sent "${t.kind}" → ${t.name || t.phone}`);
      sent++;
    } catch (err) {
      // Already claimed above — a permanent failure (e.g. an unapproved
      // template) must not retry every minute forever.
      console.error(`[post-op] "${t.kind}" send failed (already claimed, won't retry):`, err.message);
    }
  }
  return sent;
}
export const processPostOp = guarded('post-op', _processPostOp);

// No-show watch: score every lead with something scheduled, and ping the team
// the first time one crosses the threshold. Notifying once per *crossing*
// rather than once per scan is the whole point of leads.risk_notified_at —
// otherwise a single at-risk patient would generate a Slack message every
// run until their appointment.
const RISK_THRESHOLD = 60;
async function _processNoShowRisk() {
  const risks = await getNoShowRisks();
  for (const r of risks) {
    if (r.score >= RISK_THRESHOLD && !r.risk_notified_at) {
      const claimed = await markRiskNotified(r.lead_id).catch((e) => { console.error('[risk] claim failed:', e.message); return false; });
      if (!claimed) continue; // another run already claimed this crossing
      try {
        await notifyNoShowRisk({
          name: r.name, phone: r.phone, score: r.score,
          reasons: r.reasons, daysUntil: r.days_until, language: r.language,
        });
        console.log(`[risk] ${r.name || r.phone} at ${r.score}/100 — team notified`);
      } catch (err) {
        // Already claimed above — a webhook outage must not turn into a retry loop.
        console.error('[risk] notify failed (already claimed, won\'t retry):', err.message);
      }
    } else if (r.score < RISK_THRESHOLD && r.risk_notified_at) {
      // Recovered — reset so a future crossing alerts again.
      try { await clearRiskNotified(r.lead_id); } catch (e) { console.error('[risk] clear failed:', e.message); }
    }
  }
  return risks.length;
}
export const processNoShowRisk = guarded('risk', _processNoShowRisk);

// Hot leads that went silent 48h+ — one automatic WhatsApp nudge per silence.
// recordAgentMessage (is_ai=false) logs it into the thread so a coordinator
// sees it happened, same as a campaign broadcast does.
async function _processHotLeadFollowup() {
  const silent = await getSilentHotLeads();
  let sent = 0;
  for (const lead of silent) {
    const claimed = await markHotFollowupSent(lead.lead_id).catch((e) => { console.error('[hot-followup] claim failed:', e.message); return false; });
    if (!claimed) continue; // another run already has this silence episode
    try {
      await sendTemplate(lead.phone, 'hot_lead_followup', lead.language || 'en', [lead.name || 'there']);
      await recordAgentMessage(lead.lead_id, '[template: hot_lead_followup] Automatic 48h silence follow-up');
      console.log(`[hot-followup] sent → ${lead.name || lead.phone}`);
      sent++;
    } catch (err) {
      // Already claimed above — an unapproved template must not retry every run forever.
      console.error(`[hot-followup] send failed for ${lead.phone} (already claimed, won't retry):`, err.message);
    }
  }
  return sent;
}
export const processHotLeadFollowup = guarded('hot-followup', _processHotLeadFollowup);

// Devir SLA Alarmı: a handover sitting unanswered in the Action Center queue
// past the configured thresholds gets a reminder (naming the assigned
// coordinator), then — if STILL unanswered — a separate, more visible
// escalation. Both tiers are claimed atomically per conversation (same
// reasoning as every job above), so overlapping runs can't double-ping.
async function _processHandoverSla() {
  let reminded = 0;
  const dueForReminder = await getHandoversNeedingFirstReminder(config.notify.slaFirstReminderMinutes);
  for (const h of dueForReminder) {
    const claimed = await markSlaFirstReminderSent(h.conversation_id).catch((e) => { console.error('[handover-sla] reminder claim failed:', e.message); return false; });
    if (!claimed) continue; // another run already claimed this reminder
    const minutesWaiting = Math.round((Date.now() - new Date(h.escalated_at).getTime()) / 60000);
    try {
      await notifySlaFirstReminder({
        name: h.name, phone: h.phone, reason: h.handover_reason, urgent: h.urgent,
        score: h.score, language: h.language, coordinatorName: h.coordinator_name, minutesWaiting,
      });
      reminded++;
    } catch (err) {
      // Already claimed above — a webhook outage must not turn into a retry loop.
      console.error(`[handover-sla] reminder notify failed for ${h.phone} (already claimed, won't retry):`, err.message);
    }
  }

  let escalated = 0;
  const dueForEscalation = await getHandoversNeedingEscalation(config.notify.slaEscalateMinutes);
  for (const h of dueForEscalation) {
    const claimed = await markSlaEscalated(h.conversation_id).catch((e) => { console.error('[handover-sla] escalation claim failed:', e.message); return false; });
    if (!claimed) continue;
    const minutesWaiting = Math.round((Date.now() - new Date(h.escalated_at).getTime()) / 60000);
    try {
      await notifySlaEscalation({
        name: h.name, phone: h.phone, reason: h.handover_reason, urgent: h.urgent,
        score: h.score, language: h.language, coordinatorName: h.coordinator_name, minutesWaiting,
      });
      escalated++;
    } catch (err) {
      console.error(`[handover-sla] escalation notify failed for ${h.phone} (already claimed, won't retry):`, err.message);
    }
  }

  return { reminded, escalated };
}
export const processHandoverSla = guarded('handover-sla', _processHandoverSla);

// Haftalık Sonuç Raporu — clinic's own fixed timezone (same one
// repository.js's BUSINESS_HOURS already uses for every other "clinic-local
// day" computation, e.g. the analytics trend chart).
export const REPORT_TIMEZONE = 'Europe/Istanbul';

// Standard trick: format `date` as if `timeZone`'s wall-clock fields were
// UTC fields, then the difference from the real UTC instant IS that zone's
// current offset. Recomputed from `date` each call rather than hardcoded,
// so this stays correct even if REPORT_TIMEZONE is ever changed to a
// DST-observing zone (Turkey itself has had no DST since 2016).
export function getUtcOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
    .formatToParts(date)
    .reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asIfUtc - date.getTime();
}

/**
 * The current clinic-local week's [weekStart, weekEnd) — Monday 00:00
 * local through the following Monday 00:00 local, as real UTC instants —
 * plus whether "now" is clinic-local Monday at all (the only day this job
 * should ever actually fire).
 */
// Exported (not just used internally) so its tricky UTC-offset arithmetic
// can be verified directly — see scripts/test-weekly-report.mjs — rather
// than only indirectly through whether the scheduler job fires on the
// right day, which would be a much slower and less precise way to catch a
// boundary bug.
// Meta Conversions API kuyruğunu boşaltır.
//
// Yapılandırma yoksa HİÇBİR ŞEY YAPMAZ — satırları 'skipped' işaretlemez,
// 'pending' bırakır. Klinik anahtarlarını bir hafta sonra girdiğinde o
// haftanın dönüşümleri hâlâ kuyruktadır ve gider. "Anahtar yoktu" diye
// gerçekten olmuş bir ameliyatı çöpe atmak, atfetme zincirini tam da
// değerli olduğu yerden koparırdı.
async function _processConversionEvents() {
  if (!isCapiConfigured()) return { sent: 0, skipped: 0, failed: 0, held: 'capi-not-configured' };

  await expireExhaustedConversionEvents(CAPI_MAX_ATTEMPTS);
  const claimed = await claimPendingConversionEvents(CAPI_BATCH_SIZE, CAPI_MAX_ATTEMPTS);
  if (!claimed.length) return { sent: 0, skipped: 0, failed: 0 };

  // Önce kurulabilenleri ayır. Kurulamayan (ctwa_clid yok, kanal Meta'ya ait
  // değil…) bir deneme hakkı harcamaz: ağa hiç çıkmadı, tekrar denemek de
  // bir şey değiştirmez. NEDENİYLE 'skipped' olur ve panelde görünür.
  const buildable = [];
  let skipped = 0;
  for (const row of claimed) {
    const built = buildMessagingEvent({
      eventName: row.event_name,
      eventTime: row.occurred_at,
      lead: row.lead,
      value: row.value,
      currency: row.currency,
    });
    if (!built.ok) {
      await markConversionEventResult(row.id, { status: 'skipped', skipReason: built.reason });
      skipped++;
      continue;
    }
    buildable.push({ row, event: built.event, channel: built.channel });
  }
  if (!buildable.length) return { sent: 0, skipped, failed: 0 };

  const settle = async (items, res) => {
    for (const it of items) {
      await markConversionEventResult(it.row.id, {
        status: res.ok ? 'sent' : (isPermanentFailure(res.status) ? 'failed' : 'pending'),
        error: res.ok ? null : `${res.error}: ${res.body}`.slice(0, 400),
        payload: it.event,
        channel: it.channel,
      });
    }
  };

  const batch = await sendEvents(buildable.map((b) => b.event));
  if (batch.ok) {
    await settle(buildable, batch);
    return { sent: buildable.length, skipped, failed: 0 };
  }

  // Geçici hata (5xx, zaman aşımı): hepsi 'pending' kalır, bir sonraki tur
  // yeniden dener. Deneme sayacı zaten artmıştı.
  if (!isPermanentFailure(batch.status)) {
    await settle(buildable, batch);
    console.error(`[capi] geçici hata, ${buildable.length} olay kuyrukta kaldı: ${batch.error}`);
    return { sent: 0, skipped, failed: 0, retrying: buildable.length };
  }

  // Kalıcı hata (4xx): Meta gruba tek cevap döner ve hangi olayın bozuk
  // olduğunu söylemez. Grubun tamamını çöpe atmak, bir bozuk satır yüzünden
  // 19 geçerli dönüşümü kaybettirirdi — o yüzden tek tek gönderip suçluyu
  // izole ediyoruz. Yalnızca hata durumunda, yani maliyeti sınırlı.
  console.error(`[capi] grup reddedildi (${batch.status}), tek tek deneniyor: ${batch.body}`);
  let sent = 0; let failed = 0;
  for (const it of buildable) {
    const one = await sendEvents([it.event]);
    await settle([it], one);
    if (one.ok) sent++; else failed++;
  }
  return { sent, skipped, failed, isolated: true };
}
export const processConversionEvents = guarded('capi', _processConversionEvents);

export function getClinicWeekWindow(now = new Date()) {
  const offsetMs = getUtcOffsetMs(now, REPORT_TIMEZONE);
  const localNow = new Date(now.getTime() + offsetMs); // UTC getters on this now read as local wall-clock
  const weekdayIndex = (localNow.getUTCDay() + 6) % 7; // getUTCDay(): Sun=0..Sat=6 → Mon=0..Sun=6
  const localMidnightTodayAsUtc = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  const localMondayAsUtc = localMidnightTodayAsUtc - weekdayIndex * 86_400_000;
  const weekStart = new Date(localMondayAsUtc - offsetMs); // back to a real UTC instant
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  return { weekStart, weekEnd, isMonday: weekdayIndex === 0 };
}

// Fires once, on clinic-local Monday, reporting on the PRIOR week (the 7
// days that just ended) — claimed atomically via clinics.last_weekly_report_sent_at
// so an overlapping run (or Monday's tick firing more than once before the
// claim lands) can't send the same week's report twice.
async function _processWeeklyReport() {
  const { weekStart, isMonday } = getClinicWeekWindow();
  if (!isMonday) return { sent: false, reason: 'not Monday (clinic-local) yet' };

  const claimed = await claimWeeklyReportSlot(weekStart).catch((e) => { console.error('[weekly-report] claim failed:', e.message); return false; });
  if (!claimed) return { sent: false, reason: 'already sent this week' };

  const priorWeekStart = new Date(weekStart.getTime() - 7 * 86_400_000);
  const priorWeekEnd = weekStart;
  try {
    const stats = await getWeeklyReportStats({ weekStart: priorWeekStart, weekEnd: priorWeekEnd });
    await notifyWeeklyReport(stats);
    console.log(`[weekly-report] sent for ${priorWeekStart.toISOString().slice(0, 10)} – ${priorWeekEnd.toISOString().slice(0, 10)}`);
    return { sent: true, stats };
  } catch (err) {
    // Already claimed above — a transient failure here must not retry every
    // tick for the rest of the day; it'll simply be covered by next Monday's run.
    console.error('[weekly-report] compute/send failed (already claimed, will not retry today):', err.message);
    return { sent: false, reason: err.message };
  }
}
export const processWeeklyReport = guarded('weekly-report', _processWeeklyReport);
