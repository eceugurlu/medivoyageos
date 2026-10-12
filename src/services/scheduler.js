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
import { sendTemplate } from './whatsapp.js';
import { notifyNoShowRisk } from './notify.js';
import {
  getDuePostOpTasks, markPostOpSent, getNoShowRisks, markRiskNotified, clearRiskNotified,
  getSilentHotLeads, markHotFollowupSent, recordAgentMessage,
} from '../store/repository.js';

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
