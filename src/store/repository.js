import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { getProfile } from '../services/profile.js'; // draftQuoteFromLead() için — bkz. devresel import notu
import { toEur, isRatesLive } from '../services/fx.js';
import { config } from '../config.js';
import { computeAiCostFromTotals } from '../services/aiCost.js';

// The MVP runs one clinic; cache its id after first lookup.
let cachedClinicId = null;

export async function getDefaultClinicId() {
  if (cachedClinicId) return cachedClinicId;
  const { rows } = await pool.query('SELECT id FROM clinics ORDER BY created_at LIMIT 1');
  if (!rows.length) {
    throw new Error('No clinic found — run `psql "$DATABASE_URL" -f db/schema.sql` first.');
  }
  cachedClinicId = rows[0].id;
  return cachedClinicId;
}

// Optional şube scope. NULL = tüm şubeler (mevcut global davranış — kırılmaz).
// UUID-looking strings only; anything else is treated as "all".
export function normalizeUuid(value) {
  if (value == null || value === '' || value === 'all') return null;
  const s = String(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) {
    return null;
  }
  return s;
}

// Named alias kept because every branch-filtered query reads better with it,
// and because "all" collapsing to null is branch-filter semantics specifically.
export const normalizeBranchId = normalizeUuid;

// Shared by createPayment() and createCost() below — a Stripe/İyzico
// checkout session is created straight from a payment's currency (see
// stripe.js/iyzico.js), and a cost's currency feeds getProfitability()'s
// EUR conversion (fx.js), so an unrecognized code in either place would
// become a real, wrongly-priced charge or a silently-wrong report rather
// than a caught input error.
const KNOWN_CURRENCIES = new Set(['TRY', 'EUR', 'USD', 'GBP']);

/**
 * Resolve the lead + conversation for an inbound message, atomically claim
 * idempotency for it, and return the prior message history for AI context.
 *
 * The idempotency claim IS the inbound message insert itself — a plain
 * SELECT-then-decide check used to sit here instead, with the real atomic
 * INSERT only happening later in saveExchange, AFTER the AI call and the
 * outbound send. That gap was exploitable in practice (not just in theory):
 * Meta explicitly documents at-least-once webhook delivery, so a retried
 * delivery landing on a SECOND, concurrent Vercel invocation could pass the
 * SELECT check before the first invocation's INSERT had committed — each
 * invocation would then run its own AI call and send its own reply, so the
 * patient could receive the same reply twice and the clinic pays for two AI
 * calls for one message. Claiming first, via Postgres's own unique index on
 * whatsapp_message_id, means only one caller can ever get a row back,
 * regardless of how many arrive concurrently.
 *
 * Two identity paths, mirroring how each platform identifies a sender:
 * WhatsApp/widget leads are keyed by (clinic, phone); Instagram/Messenger
 * never expose a phone number, so those are keyed by (clinic, source,
 * external_id) instead — see migration 020. Pass exactly one of phone/externalId.
 */
export async function loadContext({ phone, externalId, source, name, wamid, userText, image }) {
  const clinicId = await getDefaultClinicId();

  // Don't overwrite an existing name with null in either path.
  const leadRes = externalId
    ? await pool.query(
        `INSERT INTO leads (clinic_id, external_id, source, name)
           VALUES ($1, $2, $3, $4)
         ON CONFLICT (clinic_id, source, external_id) WHERE external_id IS NOT NULL
           DO UPDATE SET name = COALESCE(leads.name, EXCLUDED.name), updated_at = now()
         RETURNING id`,
        [clinicId, externalId, source, name || null],
      )
    : await pool.query(
        `INSERT INTO leads (clinic_id, phone, name)
           VALUES ($1, $2, $3)
         ON CONFLICT (clinic_id, phone)
           DO UPDATE SET name = COALESCE(leads.name, EXCLUDED.name), updated_at = now()
         RETURNING id`,
        [clinicId, phone, name || null],
      );
  const leadId = leadRes.rows[0].id;

  // One open conversation per lead.
  const convRes = await pool.query(
    `INSERT INTO conversations (clinic_id, lead_id)
       VALUES ($1, $2)
     ON CONFLICT (lead_id) DO UPDATE SET updated_at = now()
     RETURNING id, status`,
    [clinicId, leadId],
  );
  const conversationId = convRes.rows[0].id;
  const conversationStatus = convRes.rows[0].status;

  // Recent history for the model (chronological, PRIOR turns only). Fetched
  // BEFORE the claim below inserts THIS turn's inbound message, so it's
  // never double-counted here and again by concierge.js's generateReply(),
  // which appends the current turn itself on top of this history.
  //
  // The window must be the NEWEST 40, so it's ordered DESC here and flipped
  // back to chronological below. A plain `ORDER BY created_at ASC LIMIT 40`
  // takes the OLDEST 40 instead, which looks identical until a conversation
  // passes 40 messages (~20 exchanges — very reachable in a real intake) and
  // then silently freezes the model's view at the start of the conversation:
  // it stops seeing anything the patient has said since, re-asks details they
  // already gave, and contradicts its own recent answers.
  const histRes = await pool.query(
    `SELECT role, content FROM (
       SELECT role, content, created_at FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT 40
     ) recent ORDER BY created_at ASC`,
    [conversationId],
  );

  // The atomic claim. When wamid is null the partial unique index
  // (`WHERE whatsapp_message_id IS NOT NULL`) never matches, so this is just
  // a normal insert in that case — never treated as a duplicate.
  const ins = await pool.query(
    `INSERT INTO messages (conversation_id, role, content, whatsapp_message_id, media_data, media_mime_type)
       VALUES ($1, 'user', $2, $3, $4, $5)
     ON CONFLICT (whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [conversationId, userText, wamid || null, image?.buffer || null, image?.mimeType || null],
  );
  if (ins.rowCount === 0) return { duplicate: true, history: [], ctx: {} };

  return {
    duplicate: false,
    history: histRes.rows.map((r) => ({ role: r.role, content: r.content })),
    ctx: { clinicId, leadId, conversationId, conversationStatus },
  };
}

/**
 * Update a lead from the AI's structured read of a turn (reply text is
 * handled separately by the caller — this is purely the lead-scoring/
 * handover side). Shared by saveExchange() (text channel, below — called
 * inside its own transaction via `client`) and the voice call-finalize path
 * (src/voice/session.js, called standalone with no transaction) so both
 * channels update a lead identically and can never drift into two different
 * ideas of what a given `meta` shape means.
 */
export async function applyLeadSignal(leadId, meta, client = pool) {
  if (!meta) return;
  const lead = meta.lead || {};
  const score = Number.isFinite(lead.score) ? lead.score : null;
  const handover = Boolean(meta.handover?.needed);

  await client.query(
    `UPDATE leads SET
       name               = COALESCE(name, $2),
       country            = COALESCE($3, country),
       language           = COALESCE($4, language),
       treatment_interest = COALESCE($5, treatment_interest),
       budget_hint        = COALESCE($6, budget_hint),
       readiness          = COALESCE($7, readiness),
       score              = COALESCE($8, score),
       medical_note       = COALESCE($10, medical_note),
       status             = CASE
                              WHEN leads.status = 'booked' AND NOT $9 THEN 'booked'
                              WHEN $9              THEN 'handed_over'
                              WHEN COALESCE($8,0) >= 70 THEN 'hot'
                              ELSE status
                            END,
       updated_at = now()
     WHERE id = $1`,
    [
      leadId,
      lead.name || null,
      lead.country || null,
      meta.detected_language || null,
      lead.treatment_interest || null,
      lead.budget_hint || null,
      lead.readiness || null,
      score,
      handover,
      lead.medical_note || null,
    ],
  );

  if (handover) {
    await markConversationEscalated(leadId, { reason: meta.handover.reason, urgent: meta.handover?.urgent }, client);
  }
}

/**
 * Flip a lead's conversation to `needs_human` — the ONE queue the panel's
 * Action Center (getHandoverQueue(), below) reads, regardless of which
 * channel the escalation came from. A voice-only lead (never texted) still
 * has a conversations row by the time this can fire: resolveLeadForCall()
 * (see the Voice AI section further down) creates one up front, the same way
 * loadContext()/createWidgetLead() already do for their own channels — so
 * this never silently no-ops for a lead that happens to have no `messages`.
 */
export async function markConversationEscalated(leadId, { reason, urgent } = {}, client = pool) {
  const q = await client.query(
    `UPDATE conversations
       SET status = 'needs_human', handover_reason = $2, urgent = urgent OR $3,
           escalated_at = COALESCE(escalated_at, now()), updated_at = now()
     WHERE lead_id = $1
     RETURNING id`,
    [leadId, reason || 'unspecified', Boolean(urgent)],
  );
  return Boolean(q.rows[0]);
}

/**
 * Persist the assistant's reply and update the lead from the AI's
 * structured insight, flagging handover when needed. All in one transaction
 * so a lead is never left half-updated. The inbound patient message is
 * NOT inserted here — loadContext() already claimed and inserted it,
 * atomically, before the AI call this reply came from (see its docstring).
 */
export async function saveExchange(phone, { reply, meta, usage, ctx }) {
  const { leadId, conversationId } = ctx;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Assistant reply. is_ai=true marks it as AI-authored (vs. a human agent's
    // reply via recordAgentMessage) — see the ROI Widget's getRoiStats().
    // Token counts are NULL for a failed-call fallback reply (usage=null,
    // see webhook.js) and for anything from before this column existed —
    // both are correctly excluded from the AI Maliyet Panosu's SUMs, not
    // zeroed out (a real $0 would be indistinguishable from "unknown").
    await client.query(
      `INSERT INTO messages (conversation_id, role, content, is_ai, llm_input_tokens, llm_output_tokens, llm_cached_read_tokens)
         VALUES ($1, 'assistant', $2, true, $3, $4, $5)`,
      [conversationId, reply, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.cachedReadTokens ?? null],
    );

    // Update the lead from the AI's structured read of the conversation.
    await applyLeadSignal(leadId, meta, client);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Read one lead (for pushing the freshest merged state to the CRM) ─────────
export async function getLead(leadId) {
  const { rows } = await pool.query(
    `SELECT id, clinic_id, phone, name, country, language, treatment_interest,
            budget_hint, readiness, score, status, crm_lead_id, source, external_id
       FROM leads WHERE id = $1`,
    [leadId],
  );
  return rows[0] || null;
}

// Persist the Zoho record id back onto the lead. Tolerant of a missing column
// (if the crm_lead_id migration hasn't been run yet) so CRM sync still works.
export async function setCrmLeadId(leadId, crmId) {
  try {
    await pool.query(
      `UPDATE leads SET crm_lead_id = $2, updated_at = now() WHERE id = $1`,
      [leadId, crmId],
    );
  } catch (err) {
    if (err.code === '42703') {
      console.warn(
        '[zoho] crm_lead_id column missing — run db/migrations/001_add_crm_lead_id.sql to persist the CRM id.',
      );
    } else {
      throw err;
    }
  }
}

// ── Panel queries ───────────────────────────────────────────────────────────

// Command Center KPIs (real numbers from the DB; a couple of demo constants
// come from the frontend, clearly labelled there).
// Both the Command Center's occupancy KPI and the Smart Device Booking view
// derive utilisation from this one assumption, so the two screens can't drift.
export const SLOTS_PER_DAY = 6;

// Same clinic-timezone bucketing as getAnalytics()'s trend chart, and the
// same reason: "today" compared via now()::date/created_at::date alone uses
// the DB session's default timezone (UTC on managed Postgres), not
// Europe/Istanbul — a lead created just after midnight Istanbul time is
// still the previous UTC day, so it would silently miss today's count (and,
// via device_occupancy below, misjudge which appointments are "today" too).
export async function getStats({ branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  const q = await pool.query(
    `
    SELECT
      (SELECT count(*) FROM leads l WHERE ($1::uuid IS NULL OR l.branch_id = $1)) AS total_leads,
      (SELECT count(*) FROM leads l WHERE (l.created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
         AND ($1::uuid IS NULL OR l.branch_id = $1))                              AS today_leads,
      (SELECT count(*) FROM leads l WHERE l.status = 'hot'
         AND ($1::uuid IS NULL OR l.branch_id = $1))                              AS hot_leads,
      (SELECT count(*) FROM leads l WHERE l.status = 'handed_over'
         AND ($1::uuid IS NULL OR l.branch_id = $1))                              AS handed_over,
      (SELECT count(*) FROM conversations c JOIN leads l ON l.id = c.lead_id
        WHERE c.status = 'needs_human' AND ($1::uuid IS NULL OR l.branch_id = $1)) AS needs_human,
      (SELECT count(DISTINCT l.country) FROM leads l
        WHERE l.country IS NOT NULL AND ($1::uuid IS NULL OR l.branch_id = $1)) AS countries,
      (SELECT count(*) FROM leads l WHERE l.country IS NOT NULL
         AND ($1::uuid IS NULL OR l.branch_id = $1))                              AS with_country,
      (SELECT count(*) FROM conversations c JOIN leads l ON l.id = c.lead_id
        WHERE c.status = 'ai_handling' AND ($1::uuid IS NULL OR l.branch_id = $1)) AS ai_handled,
      (SELECT count(*) FROM conversations c JOIN leads l ON l.id = c.lead_id
        WHERE ($1::uuid IS NULL OR l.branch_id = $1))                             AS total_conversations,
      -- Device occupancy is clinic-wide (devices have no branch_id yet).
      (SELECT COALESCE(round(avg(u.util)), 0) FROM (
         SELECT (count(a.id) FILTER (WHERE (a.starts_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date AND a.status = 'booked')::numeric
                 / ${SLOTS_PER_DAY}) * 100 AS util
         FROM devices d LEFT JOIN appointments a ON a.device_id = d.id
         WHERE d.active GROUP BY d.id
       ) u)                                                                    AS device_occupancy
  `,
    [bid, BUSINESS_HOURS.timezone],
  );
  const row = q.rows[0];
  const convs = Number(row.total_conversations);
  return {
    ...row,
    ai_autonomy: convs ? Math.round((Number(row.ai_handled) / convs) * 100) : null,
  };
}

// Inbox: one row per conversation with lead info + last message preview.
// Paginated — the panel used to hard-cap at 100 and silently hide older threads.
export async function listConversations({ limit = 50, offset = 0, branchId = null } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const bid = normalizeBranchId(branchId);
  const [q, countQ] = await Promise.all([
    pool.query(
      `
    SELECT
      l.id                AS lead_id,
      l.phone, l.name, l.country, l.language, l.score, l.status AS lead_status,
      l.branch_id, l.source, l.external_id,
      c.status            AS conv_status,
      c.handover_reason, c.urgent,
      lm.content          AS last_message,
      lm.role             AS last_role,
      lm.created_at       AS last_message_at
    FROM conversations c
    JOIN leads l ON l.id = c.lead_id
    LEFT JOIN LATERAL (
      SELECT content, role, created_at FROM messages m
      WHERE m.conversation_id = c.id
      ORDER BY created_at DESC LIMIT 1
    ) lm ON true
    WHERE ($3::uuid IS NULL OR l.branch_id = $3)
    ORDER BY lm.created_at DESC NULLS LAST
    LIMIT $1 OFFSET $2
  `,
      [safeLimit, safeOffset, bid],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
         FROM conversations c JOIN leads l ON l.id = c.lead_id
        WHERE ($1::uuid IS NULL OR l.branch_id = $1)`,
      [bid],
    ),
  ]);
  return {
    items: q.rows,
    total: countQ.rows[0].total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

// The Action Center handover queue.
export async function getHandoverQueue({ branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  const q = await pool.query(
    `
    SELECT l.id AS lead_id, l.phone, l.name, l.country, l.language, l.score, l.medical_note,
           l.source, l.external_id,
           c.handover_reason, c.urgent, c.updated_at
    FROM conversations c
    JOIN leads l ON l.id = c.lead_id
    WHERE c.status = 'needs_human'
      AND ($1::uuid IS NULL OR l.branch_id = $1)
    ORDER BY c.urgent DESC, l.score DESC NULLS LAST, c.updated_at DESC
  `,
    [bid],
  );
  return q.rows;
}

// ── Devir SLA Alarmı ─────────────────────────────────────────────────────
// Two independent atomic-claim tiers, same pattern as markRiskNotified/
// markPostOpSent in repository.js's post-op/no-show jobs: the SELECT finds
// candidates, the UPDATE ... WHERE <reminder column> IS NULL claims one
// before acting on it, so two overlapping scheduler runs (a slow local tick
// plus the next one, or local dev racing Vercel Cron against the same DB)
// can never send the same reminder twice. Keyed off escalated_at, NOT
// updated_at — see 023_handover_sla.sql's comment for why that distinction
// matters here specifically.
export async function getHandoversNeedingFirstReminder(afterMinutes, { branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  const q = await pool.query(
    `
    SELECT c.id AS conversation_id, c.lead_id, l.name, l.phone, l.language, l.score, l.medical_note,
           l.coordinator_id, co.name AS coordinator_name, l.source, l.external_id,
           c.handover_reason, c.urgent, c.escalated_at
    FROM conversations c
      JOIN leads l ON l.id = c.lead_id
      LEFT JOIN coordinators co ON co.id = l.coordinator_id
    WHERE c.status = 'needs_human'
      AND c.escalated_at IS NOT NULL
      AND c.escalated_at <= now() - ($1 * interval '1 minute')
      AND c.sla_first_reminder_at IS NULL
      AND ($2::uuid IS NULL OR l.branch_id = $2)
    ORDER BY c.escalated_at ASC
  `,
    [afterMinutes, bid],
  );
  return q.rows;
}

export async function markSlaFirstReminderSent(conversationId) {
  const q = await pool.query(
    `UPDATE conversations SET sla_first_reminder_at = now()
       WHERE id = $1 AND sla_first_reminder_at IS NULL RETURNING id`,
    [conversationId],
  );
  return Boolean(q.rows[0]);
}

export async function getHandoversNeedingEscalation(afterMinutes, { branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  const q = await pool.query(
    `
    SELECT c.id AS conversation_id, c.lead_id, l.name, l.phone, l.language, l.score, l.medical_note,
           l.coordinator_id, co.name AS coordinator_name, l.source, l.external_id,
           c.handover_reason, c.urgent, c.escalated_at
    FROM conversations c
      JOIN leads l ON l.id = c.lead_id
      LEFT JOIN coordinators co ON co.id = l.coordinator_id
    WHERE c.status = 'needs_human'
      AND c.escalated_at IS NOT NULL
      AND c.escalated_at <= now() - ($1 * interval '1 minute')
      AND c.sla_escalated_at IS NULL
      AND ($2::uuid IS NULL OR l.branch_id = $2)
    ORDER BY c.escalated_at ASC
  `,
    [afterMinutes, bid],
  );
  return q.rows;
}

export async function markSlaEscalated(conversationId) {
  const q = await pool.query(
    `UPDATE conversations SET sla_escalated_at = now()
       WHERE id = $1 AND sla_escalated_at IS NULL RETURNING id`,
    [conversationId],
  );
  return Boolean(q.rows[0]);
}

// Full thread for one lead.
/**
 * Delete a lead and everything hanging off them: conversation, messages (and
 * the photos stored inline on those messages), quotes, payments, notes,
 * logistics, post-op tasks — all by ON DELETE CASCADE — plus appointments,
 * which are only SET NULL and so have to go explicitly or they linger as
 * bookings belonging to nobody, still occupying a room in the utilization
 * figures.
 *
 * This is genuinely destructive and has no undo, which is exactly why the
 * route in front of it requires the caller to echo the lead's own id back.
 * It exists because a demo run, a wrong number, or a patient exercising their
 * right to erasure all leave rows that otherwise nothing in the product can
 * remove.
 */
/**
 * Reklam → Hasta Atfetme. Records WHICH ad produced this lead, on FIRST
 * touch only.
 *
 * First-touch, not last-touch, and the reason matters: a patient researching
 * surgery abroad clicks several ads over weeks before writing. Letting the
 * most recent click overwrite the first would credit the ad that closed a
 * decision the funnel's opening ad had already won, and the top of the funnel
 * would look worthless. `attributed_at IS NULL` in the WHERE is what makes
 * that a property of the data rather than of the caller remembering to check.
 *
 * The raw ad fields are stored even when no campaign row matches — a brand new
 * ad the clinic hasn't registered in the panel yet would otherwise be thrown
 * away at exactly the moment it is most interesting. resolveCampaignForLeads()
 * below back-fills those once the campaign is created.
 */
export async function attachLeadAttribution(leadId, attribution = {}) {
  const { sourceId, sourceType, sourceUrl, headline, ctwaClid } = attribution;
  if (!sourceId && !ctwaClid) return null;

  const clinicId = await getDefaultClinicId();
  // Match the ad to a campaign the clinic has registered, if one exists.
  const campaignQ = sourceId
    ? await pool.query(
        'SELECT id FROM campaigns WHERE clinic_id = $1 AND external_ref = $2',
        [clinicId, sourceId],
      )
    : { rows: [] };

  const q = await pool.query(
    `UPDATE leads SET
       campaign_id    = $2,
       ad_source_id   = $3,
       ad_source_type = $4,
       ad_source_url  = $5,
       ad_headline    = $6,
       ctwa_clid      = $7,
       attributed_at  = now(),
       updated_at     = now()
     WHERE id = $1 AND attributed_at IS NULL
     RETURNING id, campaign_id, ad_source_id`,
    [leadId, campaignQ.rows[0]?.id || null, sourceId || null, sourceType || null,
     sourceUrl || null, headline || null, ctwaClid || null],
  );
  return q.rows[0] || null; // null = already attributed; the first touch stands
}

/**
 * Back-fill: link leads whose ad was captured before the clinic registered
 * the matching campaign. Without this the honest "keep the raw id anyway"
 * choice above would still leave those leads out of every per-campaign
 * figure, which is the whole point of having kept it.
 */
export async function resolveCampaignForLeads(campaignId, externalRef) {
  if (!externalRef) return 0;
  const q = await pool.query(
    `UPDATE leads SET campaign_id = $1, updated_at = now()
      WHERE ad_source_id = $2 AND campaign_id IS NULL
      RETURNING id`,
    [campaignId, externalRef],
  );
  return q.rowCount;
}

/**
 * Per-campaign CAC and ROAS — the figure the panel previously had to refuse
 * to show (see getAnalytics()'s note: spend was real, CAC/ROAS were not
 * derivable because no lead could be tied to the campaign that paid for it).
 *
 * Revenue is EUR-converted per payment row before summing, same discipline as
 * getPaymentTotals()/getProfitability(): a plain SQL sum() would add TRY and
 * EUR together as one number and quietly inflate ROAS.
 *
 * `attributed_leads` is reported alongside every ratio on purpose. CAC over
 * three leads is noise, and a clinic about to move real ad budget deserves to
 * see the denominator rather than a confident-looking number built on it.
 */
export async function getCampaignPerformance({ branchId = null } = {}) {
  const campaignsQ = await pool.query(
    `SELECT c.id, c.name, c.channel, c.external_ref, c.active,
            c.spend::float AS spend, c.clicks,
            count(l.id)::int                                            AS leads,
            count(l.id) FILTER (WHERE l.status IN ('hot','handed_over','booked'))::int AS qualified,
            count(l.id) FILTER (WHERE l.status = 'booked')::int         AS booked
       FROM campaigns c
       LEFT JOIN leads l ON l.campaign_id = c.id AND ($1::uuid IS NULL OR l.branch_id = $1)
      GROUP BY c.id
      ORDER BY c.spend DESC NULLS LAST, c.name`,
    [branchId],
  );

  // Paid revenue per campaign, one row per payment so each can be converted
  // in its own currency before it joins the total.
  const revenueQ = await pool.query(
    `SELECT l.campaign_id, p.amount, p.currency
       FROM payments p
       JOIN leads l ON l.id = p.lead_id
      WHERE p.status = 'paid' AND l.campaign_id IS NOT NULL
        AND ($1::uuid IS NULL OR l.branch_id = $1)`,
    [branchId],
  );
  const revenueByCampaign = new Map();
  for (const r of revenueQ.rows) {
    const eur = await toEur(Number(r.amount), r.currency);
    revenueByCampaign.set(r.campaign_id, (revenueByCampaign.get(r.campaign_id) || 0) + eur);
  }

  // Ads that produced leads but match no registered campaign — shown rather
  // than dropped, because "spend we cannot see" is exactly the blind spot
  // this feature exists to remove, and silently omitting it would recreate it.
  const unmatchedQ = await pool.query(
    `SELECT l.ad_source_id, l.ad_headline, l.ad_source_type,
            count(*)::int AS leads,
            count(*) FILTER (WHERE l.status = 'booked')::int AS booked
       FROM leads l
      WHERE l.ad_source_id IS NOT NULL AND l.campaign_id IS NULL
        AND ($1::uuid IS NULL OR l.branch_id = $1)
      GROUP BY l.ad_source_id, l.ad_headline, l.ad_source_type
      ORDER BY count(*) DESC
      LIMIT 25`,
    [branchId],
  );

  const campaigns = campaignsQ.rows.map((c) => {
    const revenue = Math.round((revenueByCampaign.get(c.id) || 0) * 100) / 100;
    const spend = Number(c.spend) || 0;
    return {
      ...c,
      revenue_eur: revenue,
      // Every ratio is null (not 0) when its denominator is zero: a campaign
      // with no leads yet has an UNKNOWN cost per lead, and printing €0 would
      // read as "free", the most flattering possible lie.
      cac_eur: c.leads > 0 ? Math.round((spend / c.leads) * 100) / 100 : null,
      cost_per_booking_eur: c.booked > 0 ? Math.round((spend / c.booked) * 100) / 100 : null,
      roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null,
      conversion_pct: c.leads > 0 ? Math.round((c.booked / c.leads) * 1000) / 10 : null,
    };
  });

  const attributedLeads = campaigns.reduce((n, c) => n + c.leads, 0);
  const unattributedQ = await pool.query(
    `SELECT count(*)::int AS n FROM leads l
      WHERE l.campaign_id IS NULL AND l.ad_source_id IS NULL
        AND ($1::uuid IS NULL OR l.branch_id = $1)`,
    [branchId],
  );

  return {
    campaigns,
    unmatched_ads: unmatchedQ.rows,
    attributed_leads: attributedLeads,
    // Organic/unknown origin. Reported so the clinic can see how much of its
    // funnel attribution still cannot explain, instead of reading the
    // attributed slice as if it were the whole business.
    unattributed_leads: unattributedQ.rows[0].n,
    rates_live: isRatesLive(),
  };
}

/**
 * Correct a patient's own details. The AI fills these in from what the patient
 * writes, so a misheard name, a wrong country or a treatment guessed from an
 * ambiguous first message all end up on the record with no way to fix them —
 * and they are exactly the fields that then appear on the quote PDF and the
 * itinerary the patient receives.
 */
export async function updateLead(leadId, { name, country, language, treatmentInterest, budgetHint, status }) {
  const fields=[]; const vals=[leadId];
  if (name !== undefined) fields.push(`name = $${vals.push(name?.trim().slice(0,120) || null)}`);
  if (country !== undefined) fields.push(`country = $${vals.push(country?.trim().slice(0,80) || null)}`);
  if (language !== undefined) fields.push(`language = $${vals.push(language?.trim().slice(0,40) || null)}`);
  if (treatmentInterest !== undefined) fields.push(`treatment_interest = $${vals.push(treatmentInterest?.trim().slice(0,120) || null)}`);
  if (budgetHint !== undefined) fields.push(`budget_hint = $${vals.push(budgetHint?.trim().slice(0,80) || null)}`);
  if (status !== undefined) {
    const allowed = ['new','hot','handed_over','booked','lost'];
    if (!allowed.includes(status)) throw new Error('invalid status');
    fields.push(`status = $${vals.push(status)}`);
  }
  if (!fields.length) throw new Error('nothing to update');
  fields.push('updated_at = now()');
  const q = await pool.query(
    `UPDATE leads SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, name, phone, country, language, treatment_interest, budget_hint, status`, vals);
  if (!q.rows[0]) throw new Error('lead not found');
  return q.rows[0];
}

export async function deleteLead(leadId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const lead = await c.query('SELECT name, phone FROM leads WHERE id = $1', [leadId]);
    if (!lead.rows[0]) throw new Error('lead not found');
    const appts = await c.query('DELETE FROM appointments WHERE lead_id = $1', [leadId]);
    // calls.lead_id is ON DELETE SET NULL, not CASCADE — deliberately, so a
    // call record can outlive a lead that gets MERGED into another one. But a
    // genuine erasure request has no "merge" on the other end, so left as-is
    // it would silently orphan a patient's voice recordings/transcripts
    // (call_turns.transcript, calls.recording_url) instead of erasing them —
    // exactly the KVKK/GDPR gap this delete button exists to close. Explicit
    // delete here closes it; call_turns cascades from calls.
    const calls = await c.query('DELETE FROM calls WHERE lead_id = $1', [leadId]);
    await c.query('DELETE FROM leads WHERE id = $1', [leadId]);
    await c.query('COMMIT');
    return { name: lead.rows[0].name, phone: lead.rows[0].phone, appointments_removed: appts.rowCount, calls_removed: calls.rowCount };
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

export async function getConversationDetail(leadId) {
  const leadQ = await pool.query(
    `SELECT id, phone, name, country, language, treatment_interest, budget_hint,
            readiness, score, status, crm_lead_id, medical_note, branch_id, partner_id,
            doctor_id, doctor_review_status, doctor_note, doctor_reviewed_at, source, external_id
       FROM leads WHERE id = $1`,
    [leadId],
  );
  const lead = leadQ.rows[0];
  if (!lead) return null;

  const convQ = await pool.query(
    `SELECT id, status, handover_reason FROM conversations WHERE lead_id = $1`,
    [leadId],
  );
  const conversation = convQ.rows[0] || null;

  let messages = [];
  if (conversation) {
    const msgQ = await pool.query(
      `SELECT id, role, content, created_at, (media_mime_type IS NOT NULL) AS has_media
         FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversation.id],
    );
    messages = msgQ.rows;
  }
  // Internal coordinator notes travel with the detail so the profile panel
  // needs one request, not two. Independent of each other and of `lead` —
  // parallelized rather than four sequential round-trips.
  const [notes, payments, quotes, costs] = await Promise.all([
    listLeadNotes(leadId),
    listPaymentsForLead(leadId),
    listQuotesForLead(leadId),
    listCostsForLead(leadId),
  ]);
  return { lead, conversation, messages, notes, payments, quotes, costs };
}

// Fetches the photo bytes for one inbound message, for the panel's own
// authenticated viewer — not the patient-facing side (there is none; the
// photo came FROM the patient).
export async function getMessageMedia(messageId) {
  const q = await pool.query(
    `SELECT media_data, media_mime_type FROM messages WHERE id = $1 AND media_data IS NOT NULL`,
    [messageId],
  );
  return q.rows[0] || null;
}

// ── Internal notes ──────────────────────────────────────────────────────────
// What one coordinator needs to tell the next about a patient — "prefers
// evening calls", "brother is also enquiring". Never shown to the patient, and
// deliberately separate from leads.medical_note, which the AI writes.
export async function listLeadNotes(leadId) {
  const q = await pool.query(
    `SELECT id, author, body, created_at FROM lead_notes
       WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [leadId],
  );
  return q.rows;
}

export async function addLeadNote(leadId, body, author) {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `INSERT INTO lead_notes (clinic_id, lead_id, author, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, author, body, created_at`,
    [clinicId, leadId, author || null, body],
  );
  return q.rows[0];
}

export async function deleteLeadNote(noteId) {
  const q = await pool.query('DELETE FROM lead_notes WHERE id = $1 RETURNING id', [noteId]);
  if (!q.rows[0]) throw new Error('note not found');
  return q.rows[0];
}

// ── Payments ─────────────────────────────────────────────────────────────
// The one thing every other "real" number in this app depends on. Revenue,
// ROAS and commission are honest only once they are a sum over rows here,
// not a count of booked leads times an assumed average.
export async function listPaymentsForLead(leadId) {
  const q = await pool.query(
    `SELECT id, amount, currency, type, status, to_char(due_date, 'YYYY-MM-DD') AS due_date, paid_at,
            reminder_sent_at, note, created_at, updated_at, provider, checkout_url, link_sent_at
       FROM payments WHERE lead_id = $1 ORDER BY created_at DESC`,
    [leadId],
  );
  return q.rows;
}

export async function createPayment(leadId, { amount, currency, type, dueDate, note }) {
  const clinicId = await getDefaultClinicId();
  // Rounded to the cent before it ever reaches Stripe/İyzico: none of
  // KNOWN_CURRENCIES are zero-decimal, and Stripe's amount×100 conversion
  // (stripe.js) can land exactly on a float .5 boundary for an unrounded
  // 3+-decimal amount (e.g. 1.005 × 100 → 100.4999... → rounds down to a
  // 1-cent undercharge) — rounding the source amount itself removes the
  // input class that triggers it, for both gateways at once.
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
  const cur = (currency || 'EUR').toUpperCase().slice(0, 3);
  if (!KNOWN_CURRENCIES.has(cur)) throw new Error(`unsupported currency — use one of ${[...KNOWN_CURRENCIES].join(', ')}`);
  const q = await pool.query(
    `INSERT INTO payments (clinic_id, lead_id, amount, currency, type, due_date, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, amount, currency, type, status, to_char(due_date, 'YYYY-MM-DD') AS due_date, paid_at,
               reminder_sent_at, note, created_at, updated_at, provider, checkout_url, link_sent_at`,
    [clinicId, leadId, amt, cur, type || 'deposit', dueDate || null, note || null],
  );
  return q.rows[0];
}

export async function getPaymentById(paymentId) {
  const q = await pool.query(
    `SELECT id, lead_id, amount, currency, type, status, to_char(due_date, 'YYYY-MM-DD') AS due_date, paid_at,
            reminder_sent_at, note, created_at, updated_at, provider, checkout_url, link_sent_at
       FROM payments WHERE id = $1`,
    [paymentId],
  );
  return q.rows[0] || null;
}

// Persists the Stripe/İyzico checkout session against the payment row that
// was just created for it — see POST /conversations/:leadId/payments/link,
// which always makes a fresh payment row first, so this always writes onto a
// brand-new row rather than an existing pending one. (Double-submission from
// the panel's "create link" button is guarded client-side by disabling the
// button while the request is in flight, not by any dedup here.)
export async function setPaymentCheckout(paymentId, { provider, checkoutUrl, providerSessionId }) {
  const q = await pool.query(
    `UPDATE payments SET provider = $2, checkout_url = $3, provider_session_id = $4, updated_at = now()
       WHERE id = $1
     RETURNING id, lead_id, amount, currency, type, status, provider, checkout_url, provider_session_id`,
    [paymentId, provider, checkoutUrl, providerSessionId],
  );
  if (!q.rows[0]) throw new Error('payment not found');
  return q.rows[0];
}

export async function markPaymentLinkSent(paymentId) {
  await pool.query(`UPDATE payments SET link_sent_at = now(), updated_at = now() WHERE id = $1`, [paymentId]);
}

// The ONLY place a payment is ever marked 'paid' by anything other than a
// coordinator's manual click — driven exclusively by a signature-verified
// Stripe webhook event (see routes/stripeWebhook.js), never by the patient
// simply loading the success_url page. Idempotent: `status <> 'paid'` means
// a retried webhook delivery for the same session is a safe no-op, and
// returns null rather than throwing so the caller can tell "already handled"
// apart from "really failed".
export async function markPaymentPaidByWebhook(paymentId, providerSessionId) {
  const q = await pool.query(
    `UPDATE payments SET status = 'paid', paid_at = now(),
            provider_session_id = COALESCE(provider_session_id, $2), updated_at = now()
       WHERE id = $1 AND status <> 'paid'
     RETURNING id, lead_id, amount, currency, type`,
    [paymentId, providerSessionId],
  );
  return q.rows[0] || null;
}

// Single endpoint for every state change (paid / refunded / reminder) so the
// panel has one call to make and the timestamp columns stay consistent with
// the status they describe.
export async function updatePayment(paymentId, { status, reminder }) {
  const sets = ['updated_at = now()'];
  const vals = [];
  let i = 1;
  if (status) {
    if (!['pending', 'paid', 'refunded'].includes(status)) throw new Error('invalid status');
    sets.push(`status = $${++i}`);
    vals.push(status);
    // paid_at reflects the status it's attached to: set it on paid, clear it
    // otherwise, rather than leaving a stale timestamp on a reverted payment.
    sets.push(`paid_at = ${status === 'paid' ? 'now()' : 'NULL'}`);
  }
  if (reminder) {
    sets.push(`reminder_sent_at = now()`);
  }
  vals.unshift(paymentId);
  const q = await pool.query(
    `UPDATE payments SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, lead_id, amount, currency, type, status, to_char(due_date, 'YYYY-MM-DD') AS due_date, paid_at,
               reminder_sent_at, note, created_at, updated_at, provider, checkout_url, link_sent_at`,
    vals,
  );
  if (!q.rows[0]) throw new Error('payment not found');
  return q.rows[0];
}

// Cross-lead view for the Inbox's "Awaiting deposit" filter and any future
// dunning list — every lead with at least one payment still pending.
// Grouped by (lead_id, currency), not just lead_id: a lead can have pending
// payments in more than one currency (e.g. a EUR deposit and a later TRY
// balance), and summing those into one number under a single, arbitrarily
// picked currency label (the old `min(p.currency)`) would show an amount
// that doesn't correspond to any real payment. One row per currency a lead
// actually has pending keeps every number and its label truthful.
export async function listPendingDeposits({ branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  const q = await pool.query(
    `
    SELECT p.lead_id, p.currency, count(*)::int AS pending_count,
           sum(p.amount) AS pending_amount,
           to_char(min(p.due_date), 'YYYY-MM-DD') AS earliest_due, max(p.reminder_sent_at) AS last_reminder
      FROM payments p
      JOIN leads l ON l.id = p.lead_id
     WHERE p.status = 'pending'
       AND ($1::uuid IS NULL OR l.branch_id = $1)
     GROUP BY p.lead_id, p.currency
  `,
    [bid],
  );
  return q.rows.map((r) => ({ ...r, pending_amount: Number(r.pending_amount) }));
}

// The real revenue figure: money actually marked paid. Booked-but-unpaid
// leads contribute nothing here — as they shouldn't.
// Payments can be in any of KNOWN_CURRENCIES (İyzico/TRY and Stripe/EUR-USD-GBP
// are both live by design, so a mix is the expected steady state, not an edge
// case) — a plain SQL sum() would add a TRY amount and a EUR amount as if
// they were the same unit. Same toEur()-per-row discipline as
// getProfitability(), which is the one place in this file that already got
// this right; collected/pending here are both true EUR-equivalent totals.
export async function getPaymentTotals({ branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  const q = await pool.query(
    `
    SELECT p.amount, p.currency, p.status
    FROM payments p
    JOIN leads l ON l.id = p.lead_id
    WHERE p.status IN ('paid', 'pending')
      AND ($1::uuid IS NULL OR l.branch_id = $1)
  `,
    [bid],
  );
  let collected = 0;
  let pending = 0;
  let pendingCount = 0;
  for (const r of q.rows) {
    const eur = await toEur(Number(r.amount), r.currency);
    if (r.status === 'paid') collected += eur;
    else {
      pending += eur;
      pendingCount += 1;
    }
  }
  return {
    collected: Math.round(collected * 100) / 100,
    pending: Math.round(pending * 100) / 100,
    pending_count: pendingCount,
  };
}

// ── Multi-currency costs & net profitability ────────────────────────────
// Patient payments (`payments`) are money IN; these are money OUT — what the
// clinic itself pays the hospital, a driver, a hotel per case, often in a
// different currency than the patient paid in. See services/fx.js for how
// the two sides get normalized to EUR to become comparable.
export async function listCostsForLead(leadId) {
  const q = await pool.query(
    `SELECT id, category, amount, currency, note, created_at
       FROM operation_costs WHERE lead_id = $1 ORDER BY created_at DESC`,
    [leadId],
  );
  return q.rows;
}

export async function createCost(leadId, { category, amount, currency, note }) {
  if (!['hospital', 'driver', 'hotel', 'other'].includes(category)) throw new Error('invalid category');
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
  const cur = (currency || 'TRY').toUpperCase().slice(0, 3);
  if (!KNOWN_CURRENCIES.has(cur)) throw new Error(`unsupported currency — use one of ${[...KNOWN_CURRENCIES].join(', ')}`);
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `INSERT INTO operation_costs (clinic_id, lead_id, category, amount, currency, note)
       VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, category, amount, currency, note, created_at`,
    [clinicId, leadId, category, amt, cur, note || null],
  );
  return q.rows[0];
}

export async function deletePayment(paymentId) {
  // A paid payment is money actually collected — it drives revenue, partner
  // commission and the profitability view, so removing it would quietly
  // rewrite those figures. Correcting one is what the 'refunded' status is
  // for; only a row that never got paid can be deleted outright.
  const cur = await pool.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
  if (!cur.rows[0]) throw new Error('payment not found');
  if (cur.rows[0].status === 'paid') throw new Error('a paid payment cannot be deleted — mark it refunded instead');
  const q = await pool.query('DELETE FROM payments WHERE id = $1 RETURNING id', [paymentId]);
  return q.rows[0];
}

export async function deleteCost(costId) {
  const q = await pool.query(`DELETE FROM operation_costs WHERE id = $1 RETURNING id`, [costId]);
  if (!q.rows[0]) throw new Error('cost not found');
  return q.rows[0];
}

// Net profitability: revenue actually COLLECTED (same "paid, not booked"
// discipline as getPaymentTotals) minus costs actually logged, both converted
// to EUR — so a TRY hospital invoice and a GBP deposit can be compared honestly.
export async function getProfitability({ branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  const paymentsQ = await pool.query(
    `SELECT p.amount, p.currency FROM payments p JOIN leads l ON l.id = p.lead_id
      WHERE p.status = 'paid' AND ($1::uuid IS NULL OR l.branch_id = $1)`,
    [bid],
  );
  const costsQ = await pool.query(
    `SELECT c.amount, c.currency FROM operation_costs c JOIN leads l ON l.id = c.lead_id
      WHERE ($1::uuid IS NULL OR l.branch_id = $1)`,
    [bid],
  );
  let revenueEur = 0;
  for (const r of paymentsQ.rows) revenueEur += await toEur(Number(r.amount), r.currency);
  let costsEur = 0;
  for (const r of costsQ.rows) costsEur += await toEur(Number(r.amount), r.currency);
  return {
    revenue_eur: Math.round(revenueEur * 100) / 100,
    costs_eur: Math.round(costsEur * 100) / 100,
    net_margin_eur: Math.round((revenueEur - costsEur) * 100) / 100,
    margin_pct: revenueEur > 0 ? Math.round(((revenueEur - costsEur) / revenueEur) * 1000) / 10 : null,
    // False means the ECB API was unreachable and this used the hardcoded
    // fallback rates (see fx.js) — the panel shows a warning when this is false
    // rather than silently presenting a stale conversion as "current rate".
    rates_live: isRatesLive(),
  };
}

// ── Hot-lead follow-up (silence watch) ──────────────────────────────────
// A lead the AI scored 'hot' who then goes quiet is the easiest revenue left
// on the table — they were close, then nothing. Finds anyone gone silent 48h+
// who hasn't already been pinged for THIS silence (hot_followup_sent_at older
// than their last message, or never set) — same crossing-based dedup as the
// no-show risk watch, so a non-reply doesn't get re-messaged every day.
const HOT_FOLLOWUP_SILENCE_HOURS = 48;
export async function getSilentHotLeads() {
  // WhatsApp template sends only — a lead with no phone (Instagram/Messenger)
  // can't receive one, so it's excluded rather than left to fail send-side.
  const q = await pool.query(
    `
    SELECT l.id AS lead_id, l.name, l.phone, l.language
      FROM leads l
      JOIN conversations c ON c.lead_id = l.id
      JOIN messages m ON m.conversation_id = c.id
     WHERE l.status = 'hot' AND l.phone IS NOT NULL
     GROUP BY l.id
    HAVING max(m.created_at) < now() - interval '${HOT_FOLLOWUP_SILENCE_HOURS} hours'
       AND (l.hot_followup_sent_at IS NULL OR l.hot_followup_sent_at < max(m.created_at))
  `,
  );
  return q.rows;
}

// Atomic claim, not a plain mark: only succeeds if nobody else has claimed
// this lead's *current* silence episode in the last 24h. Called BEFORE the
// WhatsApp send (not after, like the original version) so two overlapping
// scheduler runs — a slow tick plus the next one, or a local setInterval
// racing a Vercel Cron invocation — can't both win the same lead and send
// the template twice. Returns false when someone else already claimed it.
export async function markHotFollowupSent(leadId) {
  const q = await pool.query(
    `UPDATE leads SET hot_followup_sent_at = now()
      WHERE id = $1 AND (hot_followup_sent_at IS NULL OR hot_followup_sent_at < now() - interval '24 hours')
    RETURNING id`,
    [leadId],
  );
  return Boolean(q.rows[0]);
}

// ── ROI Widget ───────────────────────────────────────────────────────────
// What to tell a prospect once the 15-day PoC ends: how much staff time the
// AI actually absorbed, how much of that happened when no human was on
// shift, and how much of the collected revenue passed through an AI-handled
// conversation at some point. MINUTES_PER_REPLY is a stated, round estimate
// (reading + translating + pricing lookup + typing one WhatsApp reply by
// hand) — shown as an assumption in the UI, not presented as measured fact.
const MINUTES_PER_AI_REPLY = 4;
const BUSINESS_HOURS = { startHour: 9, endHour: 19, timezone: 'Europe/Istanbul' }; // matches clinic-profile.js's stated hours

export async function getRoiStats({ branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  // Independent of each other — parallelized rather than sequential.
  const [q, monthly, totals] = await Promise.all([
    pool.query(
      `
    SELECT
      count(*) FILTER (WHERE m.is_ai) AS ai_replies,
      count(*) FILTER (
        WHERE m.is_ai
          AND extract(hour FROM m.created_at AT TIME ZONE $2) NOT BETWEEN $3 AND $4 - 1
      ) AS ai_replies_after_hours,
      count(DISTINCT l.id) FILTER (WHERE m.is_ai) AS leads_ai_touched
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN leads l ON l.id = c.lead_id
    WHERE ($1::uuid IS NULL OR l.branch_id = $1)
  `,
      [bid, BUSINESS_HOURS.timezone, BUSINESS_HOURS.startHour, BUSINESS_HOURS.endHour],
    ),
    // AI Maliyet Panosu — scoped to the CURRENT calendar month in the
    // clinic's own local time (same timezone-aware boundary technique as
    // the trend chart above: convert both sides to local wall-clock via
    // AT TIME ZONE before comparing, so the month doesn't flip a few hours
    // early/late against UTC). "Konuşma" = a distinct lead the AI replied
    // to at least once this month, matching how the monthly cap is meant
    // (one patient asking 10 questions is one conversation, not ten).
    pool.query(
      `
    SELECT
      count(DISTINCT l.id) FILTER (WHERE m.is_ai) AS monthly_ai_conversations,
      COALESCE(sum(m.llm_input_tokens), 0) AS monthly_input_tokens,
      COALESCE(sum(m.llm_output_tokens), 0) AS monthly_output_tokens,
      COALESCE(sum(m.llm_cached_read_tokens), 0) AS monthly_cached_read_tokens
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN leads l ON l.id = c.lead_id
    WHERE m.is_ai
      AND (m.created_at AT TIME ZONE $2) >= date_trunc('month', now() AT TIME ZONE $2)
      AND ($1::uuid IS NULL OR l.branch_id = $1)
  `,
      [bid, BUSINESS_HOURS.timezone],
    ),
    getPaymentTotals({ branchId }),
  ]);
  const r = q.rows[0];
  const aiReplies = Number(r.ai_replies);
  const m = monthly.rows[0];
  const monthlyCostUsd = computeAiCostFromTotals(
    {
      inputTokens: Number(m.monthly_input_tokens),
      outputTokens: Number(m.monthly_output_tokens),
      cachedReadTokens: Number(m.monthly_cached_read_tokens),
    },
    config.ai.pricing,
  );

  return {
    ai_replies: aiReplies,
    ai_replies_after_hours: Number(r.ai_replies_after_hours),
    leads_ai_touched: Number(r.leads_ai_touched),
    minutes_saved: aiReplies * MINUTES_PER_AI_REPLY,
    minutes_per_reply_assumption: MINUTES_PER_AI_REPLY,
    revenue_collected: totals.collected,
    business_hours: `${BUSINESS_HOURS.startHour}:00–${BUSINESS_HOURS.endHour}:00`,
    // AI Maliyet Panosu — token totals from messages predating this
    // feature are NULL and contribute 0 via COALESCE, not a gap; cost is
    // only ever as complete as the token data actually stored.
    monthly_ai_conversations: Number(m.monthly_ai_conversations),
    monthly_conversation_limit: config.ai.monthlyConversationLimit || null,
    monthly_llm_input_tokens: Number(m.monthly_input_tokens),
    monthly_llm_output_tokens: Number(m.monthly_output_tokens),
    monthly_llm_cached_read_tokens: Number(m.monthly_cached_read_tokens),
    monthly_cost_usd: monthlyCostUsd,
  };
}

// ── Quotes (Treatment Plan Builder) ─────────────────────────────────────────
// Line items are the source of truth; total_amount is always recomputed from
// them server-side, the same discipline as payments.amount — never trust a
// client-sent total.
function computeTotal(items) {
  return (Array.isArray(items) ? items : []).reduce(
    (sum, it) => sum + Number(it.qty ?? 1) * Number(it.unit_price ?? 0), 0,
  );
}
function sanitizeItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.label)
    .map((it) => ({
      label: String(it.label).slice(0, 200),
      qty: Math.max(0, Number(it.qty ?? 1)) || 1,
      unit_price: Math.max(0, Number(it.unit_price ?? 0)) || 0,
    }));
}

export async function listQuotesForLead(leadId) {
  const q = await pool.query(
    `SELECT id, items, total_amount, currency, language, status, to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
            view_token, created_at, sent_at, viewed_at, accepted_at
       FROM quotes WHERE lead_id = $1 ORDER BY created_at DESC`,
    [leadId],
  );
  return q.rows;
}

export async function createQuote(leadId, { items, currency, language, validUntil }) {
  const clinicId = await getDefaultClinicId();
  const cleanItems = sanitizeItems(items);
  const total = computeTotal(cleanItems);
  const q = await pool.query(
    `INSERT INTO quotes (clinic_id, lead_id, items, total_amount, currency, language, valid_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, items, total_amount, currency, language, status, to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
               view_token, created_at, sent_at, viewed_at, accepted_at`,
    [clinicId, leadId, JSON.stringify(cleanItems), total, (currency || 'EUR').toUpperCase().slice(0, 3), language || 'en', validUntil || null],
  );
  return q.rows[0];
}

// Pulls a first, real starting price from the clinic's own price list for the
// treatment the concierge already recorded — never a guessed number. If
// nothing matches (unrecognised treatment, or none set yet), it returns a
// single empty line at €0 so the coordinator has something to fill in rather
// than a blocked "create quote" button. Package inclusions (hotel, transfer)
// are NOT synthesised as priced line items here: the clinic profile only
// carries them as descriptive text, not real per-unit prices, and inventing
// numbers for them would be exactly the kind of fake data this project
// removes elsewhere. The coordinator adds those lines with real prices.
function firstPrice(priceRange) {
  const m = String(priceRange || '').match(/[\d.,]+/);
  if (!m) return 0;
  return Number(m[0].replace(/,/g, '')) || 0;
}
export async function draftQuoteFromLead(leadId) {
  const leadQ = await pool.query('SELECT id, name, language, treatment_interest FROM leads WHERE id = $1', [leadId]);
  const lead = leadQ.rows[0];
  if (!lead) throw new Error('lead not found');

  const profile = await getProfile();
  const interest = (lead.treatment_interest || '').toLowerCase();
  const words = interest.split(/[^a-zçğıöşü]+/i).filter((w) => w.length > 3);
  const match = (profile.treatments || []).find((t) =>
    words.some((w) => t.name.toLowerCase().includes(w)) || (interest && t.name.toLowerCase().includes(interest)),
  );

  const items = match
    ? [{ label: match.name, qty: 1, unit_price: firstPrice(match.priceRange) }]
    : [{ label: lead.treatment_interest || 'Treatment', qty: 1, unit_price: 0 }];

  // Valid for two weeks by default — matches the clinic's own "2–3 week lead
  // time" availability note; the coordinator can change it before sending.
  const validUntil = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const language = LANG_TO_ISO[lead.language] || lead.language || 'en';
  return createQuote(leadId, { items, currency: 'EUR', language, validUntil });
}
// The clinic profile lists languages as display names ("Deutsch"); quotes and
// the AI both key on ISO codes. A tiny fixed map beats depending on the AI
// having filled leads.language with an ISO code already.
const LANG_TO_ISO = { 'Türkçe':'tr', 'English':'en', 'العربية':'ar', 'Deutsch':'de', 'Русский':'ru', 'Français':'fr', 'Italiano':'it' };

export async function updateQuote(quoteId, { items, currency, language, validUntil }) {
  const current = await pool.query('SELECT status FROM quotes WHERE id = $1', [quoteId]);
  if (!current.rows[0]) throw new Error('quote not found');
  if (current.rows[0].status !== 'draft') throw new Error('only a draft quote can be edited');

  const cleanItems = items !== undefined ? sanitizeItems(items) : undefined;
  const sets = ['updated_at = now()']; // no-op column guard removed below if absent
  const fields = [];
  const vals = [quoteId];
  let i = 1;
  if (cleanItems !== undefined) { fields.push(`items = $${++i}`, `total_amount = $${++i}`); vals.push(JSON.stringify(cleanItems), computeTotal(cleanItems)); }
  if (currency) { fields.push(`currency = $${++i}`); vals.push(currency.toUpperCase().slice(0, 3)); }
  if (language) { fields.push(`language = $${++i}`); vals.push(language); }
  if (validUntil !== undefined) { fields.push(`valid_until = $${++i}`); vals.push(validUntil || null); }
  if (!fields.length) throw new Error('nothing to update');

  const q = await pool.query(
    `UPDATE quotes SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, lead_id, items, total_amount, currency, language, status, to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
               view_token, created_at, sent_at, viewed_at, accepted_at`,
    vals,
  );
  return q.rows[0];
}

export async function deleteQuote(quoteId) {
  // Only a draft can be removed. Once a quote has been sent the patient is
  // holding a link to it, and once accepted it is the record of what they
  // agreed to — deleting either would rewrite history the clinic may need.
  const cur = await pool.query('SELECT status FROM quotes WHERE id = $1', [quoteId]);
  if (!cur.rows[0]) throw new Error('quote not found');
  if (cur.rows[0].status !== 'draft') throw new Error('only a draft quote can be deleted');
  const q = await pool.query('DELETE FROM quotes WHERE id = $1 RETURNING id', [quoteId]);
  return q.rows[0];
}

export async function getQuoteById(quoteId) {
  const q = await pool.query(
    `SELECT id, lead_id, clinic_id, items, total_amount, currency, language, status,
            to_char(valid_until, 'YYYY-MM-DD') AS valid_until, view_token, created_at, sent_at, viewed_at, accepted_at
       FROM quotes WHERE id = $1`,
    [quoteId],
  );
  return q.rows[0] || null;
}

export async function getQuoteByToken(token) {
  const q = await pool.query(
    `SELECT id, lead_id, items, total_amount, currency, language, status, to_char(valid_until, 'YYYY-MM-DD') AS valid_until, viewed_at
       FROM quotes WHERE view_token = $1`,
    [token],
  );
  return q.rows[0] || null;
}

export async function markQuoteSent(quoteId) {
  const q = await pool.query(
    `UPDATE quotes SET status = 'sent', sent_at = now() WHERE id = $1 AND status = 'draft'
     RETURNING id, lead_id, status, sent_at`,
    [quoteId],
  );
  if (!q.rows[0]) throw new Error('quote not found or not in draft status');
  return q.rows[0];
}

// Idempotent on purpose: the patient may open the link (or the tracking
// pixel may fire) more than once. Only the first view moves the status and
// sets the timestamp.
export async function markQuoteViewed(quoteId) {
  await pool.query(
    `UPDATE quotes SET status = 'viewed', viewed_at = now()
      WHERE id = $1 AND viewed_at IS NULL`,
    [quoteId],
  );
}

export async function markQuoteAccepted(quoteId) {
  const q = await pool.query(
    `UPDATE quotes SET status = 'accepted', accepted_at = now() WHERE id = $1
     RETURNING id, lead_id, status, accepted_at`,
    [quoteId],
  );
  if (!q.rows[0]) throw new Error('quote not found');
  return q.rows[0];
}

// ── No-show / cancellation risk ─────────────────────────────────────────────
// Rule-based and deliberately transparent: no model, no opaque number. Every
// point added carries a reason string, and the API hands those reasons to the
// panel — a coordinator should be able to see *why* a patient is flagged and
// disagree with it. The four factors are the ones the clinic actually has real
// data for; nothing here is inferred from a guess.
//
// Maximum contributions add up to exactly 100:
//   silence     40   (5 pts per day quiet, capped at 8 days)
//   deposit     30   (overdue > pending > none recorded > paid = 0)
//   imminence   15   (≤3 days out, or ≤7)
//   wording     15   (5 pts per hesitation/cancellation phrase, max 3)
const RISK_WEIGHTS = { silence: 40, deposit: 30, imminence: 15, wording: 15 };

// Patients write in their own language, so the list covers the ones the clinic
// serves. Substring matching is crude on purpose — a false positive here costs
// a coordinator ten seconds of reading, a false negative costs a no-show.
const HESITATION_PHRASES = [
  'cancel', 'refund', 'not sure', 'changed my mind', 'too expensive', 'postpone', 'reschedule',
  'iptal', 'vazgeç', 'geri ödeme', 'çok pahalı', 'erteleyebilir',
  'stornier', 'absagen', 'erstattung', 'zu teuer', 'verschieben',
  'annuler', 'remboursement', 'trop cher', 'reporter',
  'отмен', 'возврат', 'слишком дорого', 'перенести',
  'إلغاء', 'استرداد', 'غالي',
];

const DAY_MS = 86400000;
function daysBetween(fromMs, toMs) {
  return Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
}

export function computeNoShowRisk(row, now = Date.now()) {
  // "No-show" only means something when there is something to not show up to.
  // A lead with no appointment and no inbound flight gets null, not a zero —
  // the distinction matters: one is "low risk", the other is "not applicable".
  const scheduledAt = row.next_appointment || row.flight_arrival;
  if (!scheduledAt) return null;

  const reasons = [];
  let score = 0;

  // 1) Silence. A lead that never wrote at all is treated as fully silent:
  //    the clinic has an appointment booked for someone it has never heard from.
  const daysSilent = row.last_message_at
    ? daysBetween(new Date(row.last_message_at).getTime(), now)
    : 8;
  const silencePts = Math.min(RISK_WEIGHTS.silence, daysSilent * 5);
  if (silencePts > 0) {
    score += silencePts;
    reasons.push({ factor: 'silence', points: silencePts, detail: String(daysSilent) });
  }

  // 2) Deposit. Money already collected is the strongest signal a patient will
  //    turn up, so a paid deposit contributes nothing at all.
  let depositPts = 0;
  let depositDetail = null;
  if (row.has_paid) {
    depositPts = 0;
  } else if (row.earliest_pending_due && new Date(row.earliest_pending_due).getTime() < now) {
    depositPts = RISK_WEIGHTS.deposit;
    depositDetail = 'overdue';
  } else if (row.earliest_pending_due || row.has_pending) {
    depositPts = 15;
    depositDetail = 'pending';
  } else {
    depositPts = 20;
    depositDetail = 'none';
  }
  if (depositPts > 0) {
    score += depositPts;
    reasons.push({ factor: 'deposit', points: depositPts, detail: depositDetail });
  }

  // 3) Imminence. Not risk on its own — it is what makes the other signals
  //    urgent rather than merely worth watching.
  const daysUntil = daysBetween(now, new Date(scheduledAt).getTime());
  let imminencePts = 0;
  if (daysUntil <= 3) imminencePts = RISK_WEIGHTS.imminence;
  else if (daysUntil <= 7) imminencePts = 8;
  if (imminencePts > 0) {
    score += imminencePts;
    reasons.push({ factor: 'imminence', points: imminencePts, detail: String(daysUntil) });
  }

  // 4) Wording, from the patient's own messages only — never from the clinic's.
  const haystack = (row.recent_patient_texts || []).join(' \n ').toLowerCase();
  const hits = HESITATION_PHRASES.filter((phrase) => haystack.includes(phrase));
  const wordingPts = Math.min(RISK_WEIGHTS.wording, hits.length * 5);
  if (wordingPts > 0) {
    score += wordingPts;
    reasons.push({ factor: 'wording', points: wordingPts, detail: hits.slice(0, 3).join(', ') });
  }

  return {
    score: Math.min(100, score),
    reasons,
    days_until: daysUntil,
    days_silent: daysSilent,
    scheduled_at: scheduledAt,
  };
}

export async function getNoShowRisks({ branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  const q = await pool.query(
    `
    SELECT l.id, l.name, l.phone, l.language, l.country, l.status, l.risk_notified_at, l.source, l.external_id,
      (SELECT max(m.created_at) FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.lead_id = l.id)                                        AS last_message_at,
      (SELECT min(a.starts_at) FROM appointments a
        WHERE a.lead_id = l.id AND a.status = 'booked' AND a.starts_at > now()) AS next_appointment,
      (SELECT lg.arrival_at FROM logistics lg
        WHERE lg.lead_id = l.id AND lg.arrival_at > now())             AS flight_arrival,
      EXISTS(SELECT 1 FROM payments p WHERE p.lead_id = l.id AND p.status = 'paid')    AS has_paid,
      EXISTS(SELECT 1 FROM payments p WHERE p.lead_id = l.id AND p.status = 'pending') AS has_pending,
      (SELECT min(p.due_date) FROM payments p
        WHERE p.lead_id = l.id AND p.status = 'pending')               AS earliest_pending_due,
      COALESCE((
        SELECT array_agg(t.content) FROM (
          SELECT m.content FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
           WHERE c.lead_id = l.id AND m.role = 'user'
           ORDER BY m.created_at DESC LIMIT 5
        ) t
      ), ARRAY[]::text[])                                              AS recent_patient_texts
    FROM leads l
    WHERE l.status <> 'lost'
      AND ($1::uuid IS NULL OR l.branch_id = $1)
  `,
    [bid],
  );

  return q.rows
    .map((row) => {
      const risk = computeNoShowRisk(row);
      if (!risk) return null;
      return {
        lead_id: row.id,
        name: row.name,
        phone: row.phone,
        language: row.language,
        country: row.country,
        risk_notified_at: row.risk_notified_at,
        source: row.source,
        external_id: row.external_id,
        ...risk,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

// Atomic claim, called BEFORE notifying (not after): WHERE risk_notified_at
// IS NULL means only one overlapping scheduler run can ever win a given
// lead's crossing. Returns false when another run already claimed it, so
// the team doesn't get paged twice for the same crossing.
export async function markRiskNotified(leadId) {
  const q = await pool.query(
    'UPDATE leads SET risk_notified_at = now() WHERE id = $1 AND risk_notified_at IS NULL RETURNING id',
    [leadId],
  );
  return Boolean(q.rows[0]);
}
export async function clearRiskNotified(leadId) {
  await pool.query(
    'UPDATE leads SET risk_notified_at = NULL WHERE id = $1 AND risk_notified_at IS NOT NULL',
    [leadId],
  );
}

// Set a conversation's status (takeover / hand back to AI / close). Clears
// the Devir SLA Alarmı tracking columns whenever the conversation leaves
// 'needs_human' — a coordinator taking it over (or closing it) genuinely
// resolves the wait, so a LATER, fresh escalation on the same lead must start
// its own SLA clock rather than look like a reminder/escalation already sent.
export async function setConversationStatus(leadId, status) {
  const q = await pool.query(
    `UPDATE conversations SET
       status = $2,
       escalated_at          = CASE WHEN $2 = 'needs_human' THEN escalated_at          ELSE NULL END,
       sla_first_reminder_at = CASE WHEN $2 = 'needs_human' THEN sla_first_reminder_at ELSE NULL END,
       sla_escalated_at      = CASE WHEN $2 = 'needs_human' THEN sla_escalated_at      ELSE NULL END,
       updated_at = now()
     WHERE lead_id = $1 RETURNING id, status`,
    [leadId, status],
  );
  return q.rows[0] || null;
}

// Record a manual message an agent typed in the panel (role='assistant').
export async function recordAgentMessage(leadId, content) {
  const convQ = await pool.query(`SELECT id FROM conversations WHERE lead_id = $1`, [leadId]);
  const conv = convQ.rows[0];
  if (!conv) return null;
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content, is_ai) VALUES ($1, 'assistant', $2, false)`,
    [conv.id, content],
  );
  return conv.id;
}

// Everything services/channelSend.js's sendToLead() needs to pick the right
// channel and language for a panel-triggered send (currently: payment links),
// plus country for the payment providers' required buyer/billing fields.
export async function getLeadChannel(leadId) {
  const q = await pool.query(
    `SELECT phone, external_id, source, language, name, country FROM leads WHERE id = $1`,
    [leadId],
  );
  return q.rows[0] || null;
}

// ── Lead Collection Widget ──────────────────────────────────────────────────
// Create a lead from a web widget submission and open a conversation with the
// patient's inquiry as the first message. Feeds the same pipeline as WhatsApp.
export async function createWidgetLead(d) {
  const clinicId = await getDefaultClinicId();
  // Referral attribution: widget.html forwards a ?ref=<partner's PUBLIC
  // referral_code> from the link a partner shares, if present — but ONLY for
  // a genuinely new lead (the INSERT branch below). Deliberately absent from
  // the ON CONFLICT branch: without that, an existing lead with real prior
  // history (their own organic WhatsApp thread, quotes, payments) could be
  // retroactively credited to a partner by anyone submitting that same phone
  // number through a ?ref= link later — turning the partner's commission
  // math into something they never actually earned.
  let partnerId = null;
  if (d.referralCode) {
    const partner = await getPartnerByReferralCode(d.referralCode);
    if (partner) partnerId = partner.id;
  }
  const leadRes = await pool.query(
    `INSERT INTO leads (clinic_id, phone, name, country, language, treatment_interest, budget_hint, source, status, consent, partner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'widget','new',$8,$9)
     ON CONFLICT (clinic_id, phone) DO UPDATE SET
       name = COALESCE(leads.name, EXCLUDED.name),
       treatment_interest = COALESCE(EXCLUDED.treatment_interest, leads.treatment_interest),
       budget_hint = COALESCE(EXCLUDED.budget_hint, leads.budget_hint),
       country = COALESCE(EXCLUDED.country, leads.country),
       consent = leads.consent OR EXCLUDED.consent,
       updated_at = now()
     RETURNING id`,
    [clinicId, d.phone, d.name || null, d.country || null, d.language || null,
     d.treatment || null, d.budget || null, d.consent === true, partnerId],
  );
  const leadId = leadRes.rows[0].id;
  const convRes = await pool.query(
    `INSERT INTO conversations (clinic_id, lead_id, channel)
       VALUES ($1,$2,'widget')
     ON CONFLICT (lead_id) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [clinicId, leadId],
  );
  const conversationId = convRes.rows[0].id;
  const inquiry = d.message
    || `New website enquiry: ${d.treatment || 'treatment'}${d.budget ? ' (budget ' + d.budget + ')' : ''}.`;
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)`,
    [conversationId, inquiry],
  );
  return { leadId, conversationId };
}

// ── Analytics (CAC / ROAS / funnel / trend) ─────────────────────────────────
export async function getAnalytics({ branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  // Bucketed in the CLINIC's timezone (same BUSINESS_HOURS.timezone used by
  // getRoiStats below), not the DB session's default (UTC on managed
  // Postgres) — a lead created at, say, 01:00 Istanbul time is 22:00 UTC the
  // PREVIOUS day, so a plain now()::date/created_at::date comparison would
  // silently misfile it under yesterday's bar on this chart. `day` comes
  // back as a plain YYYY-MM-DD string (to_char), not a date/timestamp — the
  // frontend must NOT run it through `new Date(...)`, which would reinterpret
  // it in the BROWSER's own local zone and could shift the displayed day
  // number by one again, undoing the fix on the way back out.
  const trend = await pool.query(
    `
    SELECT to_char(d, 'YYYY-MM-DD') AS day, count(l.id) AS count
    FROM generate_series(
      (now() AT TIME ZONE $2)::date - interval '13 days',
      (now() AT TIME ZONE $2)::date,
      interval '1 day'
    ) d
    LEFT JOIN leads l ON (l.created_at AT TIME ZONE $2)::date = d::date
      AND ($1::uuid IS NULL OR l.branch_id = $1)
    GROUP BY d ORDER BY d
  `,
    [bid, BUSINESS_HOURS.timezone],
  );
  const funnel = await pool.query(
    `
    SELECT
      (SELECT count(*) FROM leads l WHERE ($1::uuid IS NULL OR l.branch_id = $1)) AS leads,
      (SELECT count(*) FROM leads l WHERE l.status IN ('hot','handed_over','booked')
         AND ($1::uuid IS NULL OR l.branch_id = $1)) AS qualified,
      (SELECT count(*) FROM leads l WHERE l.status IN ('handed_over','booked')
         AND ($1::uuid IS NULL OR l.branch_id = $1)) AS handed_over,
      (SELECT count(*) FROM leads l WHERE l.status = 'booked'
         AND ($1::uuid IS NULL OR l.branch_id = $1)) AS booked
  `,
    [bid],
  );
  const bySource = await pool.query(
    `
    SELECT COALESCE(source,'unknown') AS source, count(*) AS count
    FROM leads l
    WHERE ($1::uuid IS NULL OR l.branch_id = $1)
    GROUP BY source ORDER BY count DESC
  `,
    [bid],
  );
  const byLang = await pool.query(
    `
    SELECT COALESCE(language,'?') AS language, count(*) AS count
    FROM leads l
    WHERE ($1::uuid IS NULL OR l.branch_id = $1)
    GROUP BY language ORDER BY count DESC
  `,
    [bid],
  );
  const spend = await pool.query(`SELECT COALESCE(sum(spend),0) AS total_spend, COALESCE(sum(clicks),0) AS total_clicks FROM campaigns`);
  // Per-channel spend and cost-per-click are real. Per-channel CAC/ROAS are NOT
  // derivable yet: leads.source records how a lead arrived (whatsapp, widget),
  // not which campaign paid for it, so no lead can be attributed to a channel.
  // Fixing that needs a campaign ref on the lead (UTM on the widget, or a
  // click-to-chat ref on WhatsApp) — until then we publish spend, not CAC.
  const byChannel = await pool.query(`
    SELECT channel,
           COALESCE(sum(spend),0)  AS spend,
           COALESCE(sum(clicks),0) AS clicks
    FROM campaigns GROUP BY channel ORDER BY spend DESC
  `);

  // Always returned — panel shows şube kırılımı even when a single branch is
  // selected (that row simply dominates). Unassigned leads are a separate row
  // with branch_id null so they don't disappear into a named şube.
  const byBranch = await pool.query(`
    SELECT b.id AS branch_id, b.name, b.code, b.is_default,
      count(l.id)::int AS leads,
      count(l.id) FILTER (WHERE l.status = 'booked')::int AS booked
    FROM branches b
    LEFT JOIN leads l ON l.branch_id = b.id
    WHERE b.active
    GROUP BY b.id
    ORDER BY b.is_default DESC, b.name
  `);
  const unassigned = await pool.query(`
    SELECT count(*)::int AS leads,
           count(*) FILTER (WHERE status = 'booked')::int AS booked
    FROM leads WHERE branch_id IS NULL
  `);
  // Revenue per branch, EUR-converted per row before summing — a plain SQL
  // sum() here would add TRY/EUR/USD/GBP payments together as one number
  // (see getPaymentTotals() above for the same fix and why it matters).
  // Not scoped by $1 (branchId) on purpose, same as byBranch/unassigned:
  // this breakdown always shows every branch regardless of the selected filter.
  const paidByBranch = await pool.query(`
    SELECT p.amount, p.currency, lp.branch_id
      FROM payments p JOIN leads lp ON lp.id = p.lead_id
     WHERE p.status = 'paid'
  `);
  const revenueByBranch = new Map();
  for (const r of paidByBranch.rows) {
    const eur = await toEur(Number(r.amount), r.currency);
    const key = r.branch_id || 'unassigned';
    revenueByBranch.set(key, (revenueByBranch.get(key) || 0) + eur);
  }
  const branchRevenue = (key) => Math.round((revenueByBranch.get(key) || 0) * 100) / 100;

  const totalLeads = Number(funnel.rows[0].leads);
  const totalSpend = Number(spend.rows[0].total_spend);
  const cac = totalLeads ? +(totalSpend / totalLeads).toFixed(2) : 0;
  // Revenue is now a real sum over payments.status = 'paid' — see migration
  // 009. It reads as zero until deposits are logged, which is the honest
  // number: no money has been recorded as collected yet.
  const paymentTotals = await getPaymentTotals({ branchId: bid });
  const revenue = paymentTotals.collected;
  const roas = totalSpend ? +(revenue / totalSpend).toFixed(2) : 0;

  const byBranchRows = byBranch.rows.map((r) => ({
    branch_id: r.branch_id,
    name: r.name,
    code: r.code,
    is_default: r.is_default,
    leads: Number(r.leads),
    booked: Number(r.booked),
    revenue: branchRevenue(r.branch_id),
  }));
  const u = unassigned.rows[0];
  if (Number(u.leads) > 0) {
    byBranchRows.push({
      branch_id: null,
      name: null,
      code: null,
      is_default: false,
      unassigned: true,
      leads: Number(u.leads),
      booked: Number(u.booked),
      revenue: branchRevenue('unassigned'),
    });
  }

  return {
    trend: trend.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
    funnel: funnel.rows[0],
    by_source: bySource.rows,
    by_language: byLang.rows,
    by_branch: byBranchRows,
    spend: { total_spend: totalSpend, total_clicks: Number(spend.rows[0].total_clicks) },
    by_channel: byChannel.rows.map((r) => {
      const s = Number(r.spend), c = Number(r.clicks);
      return { channel: r.channel, spend: s, clicks: c, cpc: c ? +(s / c).toFixed(2) : null };
    }),
    // Flag the panel uses to label channel-level CAC honestly — still not
    // derivable (see the note above by_channel).
    channel_attribution: false,
    cac, roas, revenue,
    payments_pending: paymentTotals.pending,
    payments_pending_count: paymentTotals.pending_count,
  };
}

// ── Haftalık Sonuç Raporu ───────────────────────────────────────────────────
// Atomic claim before computing/sending — same pattern as every scheduler
// job's markXSent (see scheduler.js) — so two overlapping runs (local
// setInterval + Vercel Cron, or a slow tick racing the next one) can't send
// the same week's report twice. Scoped by clinic (there's only one right
// now), but the column lives on `clinics` so a future multi-clinic
// deployment doesn't need a schema change here too.
export async function claimWeeklyReportSlot(weekStart) {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `UPDATE clinics SET last_weekly_report_sent_at = now()
       WHERE id = $1 AND (last_weekly_report_sent_at IS NULL OR last_weekly_report_sent_at < $2)
     RETURNING id`,
    [clinicId, weekStart],
  );
  return Boolean(q.rows[0]);
}

/**
 * Stats for one Monday-to-Monday week [weekStart, weekEnd). Reuses the exact
 * EUR-conversion getPaymentTotals() already uses (fx.js's toEur) so the
 * deposit figure matches what the rest of the panel shows for the same
 * payments, not a second, slightly different computation of the same number.
 *
 * `missed_conversations` is DELIBERATELY a current snapshot (every lead
 * still waiting for a human, right now), not scoped to the week — scoping
 * it by `conversations.updated_at` would undercount: that column gets
 * touched by any new patient message even while still escalated, so a
 * conversation that's been neglected since the PREVIOUS week would have a
 * stale updated_at and silently vanish from every later report instead of
 * keeping nagging about it. A snapshot of "how many are waiting right now"
 * is the more honest, more actionable number for a weekly owner summary.
 */
export async function getWeeklyReportStats({ weekStart, weekEnd, branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);

  const leadStats = await pool.query(
    `
    SELECT
      count(*) AS new_leads,
      count(*) FILTER (WHERE status IN ('hot','handed_over','booked')) AS qualified_leads,
      count(*) FILTER (WHERE status = 'hot') AS hot_leads
    FROM leads
    WHERE created_at >= $1 AND created_at < $2
      AND ($3::uuid IS NULL OR branch_id = $3)
  `,
    [weekStart, weekEnd, bid],
  );

  const appointments = await pool.query(
    `
    SELECT count(*) AS booked
    FROM appointments a JOIN leads l ON l.id = a.lead_id
    WHERE a.created_at >= $1 AND a.created_at < $2 AND a.status = 'booked'
      AND ($3::uuid IS NULL OR l.branch_id = $3)
  `,
    [weekStart, weekEnd, bid],
  );

  const payments = await pool.query(
    `
    SELECT p.amount, p.currency
    FROM payments p JOIN leads l ON l.id = p.lead_id
    WHERE p.status = 'paid' AND p.paid_at >= $1 AND p.paid_at < $2
      AND ($3::uuid IS NULL OR l.branch_id = $3)
  `,
    [weekStart, weekEnd, bid],
  );
  let depositsEur = 0;
  for (const r of payments.rows) depositsEur += await toEur(Number(r.amount), r.currency);

  // Average time from a patient's message to the next reply in the SAME
  // conversation, for patient messages sent within the week — a window
  // function (LEAD), not a correlated subquery, so this stays fast as
  // messages grows.
  const responseTime = await pool.query(
    `
    WITH turns AS (
      SELECT m.role, m.created_at,
             LEAD(m.role) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at) AS next_role,
             LEAD(m.created_at) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at) AS next_at
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM leads l WHERE l.id = c.lead_id AND l.branch_id = $1))
    )
    SELECT avg(EXTRACT(EPOCH FROM (next_at - created_at))) AS avg_seconds, count(*) AS replied_turns
    FROM turns
    WHERE role = 'user' AND next_role = 'assistant'
      AND created_at >= $2 AND created_at < $3
  `,
    [bid, weekStart, weekEnd],
  );

  const missed = await pool.query(
    `
    SELECT count(*) AS missed
    FROM conversations c JOIN leads l ON l.id = c.lead_id
    WHERE c.status = 'needs_human' AND ($1::uuid IS NULL OR l.branch_id = $1)
  `,
    [bid],
  );

  return {
    period: { start: weekStart, end: weekEnd },
    new_leads: Number(leadStats.rows[0].new_leads),
    qualified_leads: Number(leadStats.rows[0].qualified_leads),
    hot_leads: Number(leadStats.rows[0].hot_leads),
    appointments_booked: Number(appointments.rows[0].booked),
    deposits_collected_eur: Math.round(depositsEur * 100) / 100,
    avg_response_seconds: responseTime.rows[0].avg_seconds != null ? Math.round(Number(responseTime.rows[0].avg_seconds)) : null,
    replied_turns: Number(responseTime.rows[0].replied_turns),
    missed_conversations_now: Number(missed.rows[0].missed),
  };
}

// ── Broadcast segments ──────────────────────────────────────────────────────
// Feeds /campaigns/broadcast, which sends a WhatsApp template — a channel
// concept Instagram/Messenger don't have an equivalent of — so leads with no
// phone (see migration 020_multichannel.sql) are excluded here rather than
// left to fail one-by-one inside the broadcast loop's per-recipient try/catch.
export async function getLeadsBySegment(segment) {
  const statusFilter = {
    all: '',
    past: `status IN ('handed_over','booked') AND`,
    hot: `status = 'hot' AND`,
    new: `status = 'new' AND`,
  }[segment] ?? '';
  const q = await pool.query(
    `SELECT id, phone, name, language FROM leads WHERE ${statusFilter} phone IS NOT NULL ORDER BY created_at DESC`,
  );
  return q.rows;
}

// Seed a few demo ad campaigns (idempotent-ish: only if table is empty).
export async function seedCampaignsIfEmpty() {
  const c = await pool.query('SELECT count(*)::int AS n FROM campaigns');
  if (c.rows[0].n > 0) return false;
  const clinicId = await getDefaultClinicId();
  await pool.query(
    `INSERT INTO campaigns (clinic_id, name, channel, spend, clicks) VALUES
      ($1,'UK Hair – Meta','meta_ads',1800,240),
      ($1,'DACH Dental – Google','google',1200,160),
      ($1,'GCC Aesthetics – Instagram','instagram',2100,300)`,
    [clinicId],
  );
  return true;
}

// ── Coordinators / language matching (Modül 4+5) ────────────────────────────
// ── Coordinator (consultant) management ─────────────────────────────────────
// Until now coordinators only ever existed as seed rows, which meant a clinic
// could see the Language Matching feature but never staff it with its own
// people. These are the create/update paths behind that tab.

// Stored as a Postgres TEXT[] of ISO codes, because assignCoordinatorByLanguage
// matches against the AI's detected_language, which is an ISO code too.
function sanitizeLanguages(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set();
  for (const raw of list) {
    const code = String(raw || '').trim().toLowerCase();
    if (/^[a-z]{2}$/.test(code)) seen.add(code);
  }
  return [...seen].slice(0, 8);
}

export async function listAllCoordinators() {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `SELECT id, name, languages, active, branch_id, phone, created_at
       FROM coordinators WHERE clinic_id = $1 ORDER BY active DESC, name`,
    [clinicId],
  );
  return q.rows;
}

export async function createCoordinator({ name, languages, branchId, phone }) {
  if (!name || !name.trim()) throw new Error('coordinator name is required');
  const langs = sanitizeLanguages(languages);
  if (!langs.length) throw new Error('at least one language is required');
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `INSERT INTO coordinators (clinic_id, name, languages, branch_id, phone)
       VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, languages, active, branch_id, phone, created_at`,
    [clinicId, name.trim().slice(0, 120), langs, normalizeBranchId(branchId), phone?.trim().slice(0, 40) || null],
  );
  return q.rows[0];
}

export async function updateCoordinator(id, { name, languages, branchId, active, phone }) {
  const fields = [];
  const vals = [id];
  if (name !== undefined) {
    if (!name || !name.trim()) throw new Error('coordinator name is required');
    fields.push(`name = $${vals.push(name.trim().slice(0, 120))}`);
  }
  if (languages !== undefined) {
    const langs = sanitizeLanguages(languages);
    if (!langs.length) throw new Error('at least one language is required');
    fields.push(`languages = $${vals.push(langs)}`);
  }
  // branchId is deliberately settable to null ("no branch"), so it keys off
  // the property being present rather than being truthy.
  if (branchId !== undefined) fields.push(`branch_id = $${vals.push(normalizeBranchId(branchId))}`);
  if (active !== undefined) fields.push(`active = $${vals.push(Boolean(active))}`);
  // Real, callable number for sesli AI's warm-transfer `<Dial>` — settable to
  // null ("no transfer number yet"), same reasoning as branchId above.
  if (phone !== undefined) fields.push(`phone = $${vals.push(phone?.trim().slice(0, 40) || null)}`);
  if (!fields.length) throw new Error('nothing to update');

  const q = await pool.query(
    `UPDATE coordinators SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, name, languages, active, branch_id, phone, created_at`,
    vals,
  );
  if (!q.rows[0]) throw new Error('coordinator not found');
  return q.rows[0];
}

export async function deleteCoordinator(id) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // leads.coordinator_id carries no foreign key (see schema), so nothing at
    // the database level would stop a deleted coordinator's id from staying on
    // their leads as a dangling reference — those leads would then show an
    // assignee who no longer exists and quietly drop out of the matching
    // view's coverage. Clear the assignment first, in the same transaction.
    const freed = await c.query('UPDATE leads SET coordinator_id = NULL WHERE coordinator_id = $1', [id]);
    const del = await c.query('DELETE FROM coordinators WHERE id = $1 RETURNING name', [id]);
    if (!del.rows[0]) throw new Error('coordinator not found');
    await c.query('COMMIT');
    return { name: del.rows[0].name, leads_unassigned: freed.rowCount };
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

export async function seedCoordinatorsIfEmpty() {
  const c = await pool.query('SELECT count(*)::int AS n FROM coordinators');
  if (c.rows[0].n > 0) return false;
  const clinicId = await getDefaultClinicId();
  await pool.query(
    `INSERT INTO coordinators (clinic_id, name, languages) VALUES
      ($1,'Anna Weber',   '{de,en}'),
      ($1,'Omar Haddad',  '{ar,en}'),
      ($1,'Dmitry Volkov','{ru,en}'),
      ($1,'Sophie Dubois','{fr,en}'),
      ($1,'Mehmet Demir', '{tr,en}')`,
    [clinicId],
  );
  return true;
}

// Öncelik 4: şube listesi + ilk açılışta demo şubeler. Mevcut lead/koordinatör
// satırlarına branch_id yazmak kırılmaz — NULL zaten "atanmamış" demek; seed
// sadece boş tabloda çalışır ve mevcut kayıtlara nazikçe dağıtır.
export async function listBranches() {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `SELECT id, name, code, city, is_default, active, twilio_number
       FROM branches WHERE clinic_id = $1 AND active
       ORDER BY is_default DESC, name`,
    [clinicId],
  );
  return q.rows;
}

// ── Branch management ───────────────────────────────────────────────────────
// listBranches() above powers the branch filter and so returns active rows
// only; management needs to see a deactivated branch too, otherwise switching
// one off would make it unreachable to switch back on.
export async function listAllBranches() {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `SELECT id, name, code, city, is_default, active, twilio_number
       FROM branches WHERE clinic_id = $1
       ORDER BY is_default DESC, active DESC, name`,
    [clinicId],
  );
  return q.rows;
}

export async function createBranch({ name, code, city, twilioNumber }) {
  if (!name || !name.trim()) throw new Error('branch name is required');
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `INSERT INTO branches (clinic_id, name, code, city, twilio_number) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, code, city, is_default, active, twilio_number`,
    [clinicId, name.trim().slice(0, 120), code?.trim().slice(0, 30) || null, city?.trim().slice(0, 80) || null,
     twilioNumber?.trim().slice(0, 20) || null],
  );
  return q.rows[0];
}

export async function updateBranch(id, { name, code, city, active, twilioNumber }) {
  const fields = [];
  const vals = [id];
  if (name !== undefined) {
    if (!name || !name.trim()) throw new Error('branch name is required');
    fields.push(`name = $${vals.push(name.trim().slice(0, 120))}`);
  }
  if (code !== undefined) fields.push(`code = $${vals.push(code?.trim().slice(0, 30) || null)}`);
  if (city !== undefined) fields.push(`city = $${vals.push(city?.trim().slice(0, 80) || null)}`);
  // The number a patient dials for sesli AI to route to THIS branch's profile
  // (bkz. 023_voice_calls.sql's unique partial index) — settable to null.
  if (twilioNumber !== undefined) fields.push(`twilio_number = $${vals.push(twilioNumber?.trim().slice(0, 20) || null)}`);
  if (active !== undefined) {
    // The default branch is what unassigned leads and the "all branches" view
    // fall back to, so switching it off would leave that fallback pointing at
    // a branch the clinic can no longer see or pick.
    if (!active) {
      const d = await pool.query('SELECT is_default FROM branches WHERE id = $1', [id]);
      if (!d.rows[0]) throw new Error('branch not found');
      if (d.rows[0].is_default) throw new Error('the default branch cannot be deactivated');
    }
    fields.push(`active = $${vals.push(Boolean(active))}`);
  }
  if (!fields.length) throw new Error('nothing to update');

  const q = await pool.query(
    `UPDATE branches SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, name, code, city, is_default, active, twilio_number`,
    vals,
  );
  if (!q.rows[0]) throw new Error('branch not found');
  return q.rows[0];
}

export async function deleteBranch(id) {
  const d = await pool.query('SELECT is_default FROM branches WHERE id = $1', [id]);
  if (!d.rows[0]) throw new Error('branch not found');
  // Same reasoning as refusing to deactivate it (see updateBranch): the default
  // branch is the fallback every unassigned lead and the "all branches" view
  // resolve to, so removing it would leave that fallback pointing at nothing.
  if (d.rows[0].is_default) throw new Error('the default branch cannot be deleted');
  // leads.branch_id and coordinators.branch_id are both ON DELETE SET NULL, so
  // staff and patients survive the branch closing — they simply become
  // unassigned rather than disappearing with it.
  const q = await pool.query('DELETE FROM branches WHERE id = $1 RETURNING name', [id]);
  return q.rows[0];
}

export async function seedBranchesIfEmpty() {
  const clinicId = await getDefaultClinicId();
  const c = await pool.query('SELECT count(*)::int AS n FROM branches WHERE clinic_id = $1', [clinicId]);
  if (c.rows[0].n > 0) return false;

  const ins = await pool.query(
    `INSERT INTO branches (clinic_id, name, code, city, is_default) VALUES
       ($1, 'Ana Şube',  'MAIN', 'Istanbul', true),
       ($1, 'Nişantaşı', 'NIS',  'Istanbul', false),
       ($1, 'Ataşehir',  'ATA',  'Istanbul', false)
     RETURNING id, code, is_default`,
    [clinicId],
  );
  const byCode = Object.fromEntries(ins.rows.map((r) => [r.code, r.id]));

  // Spread existing coordinators across şubeler so Matching/Consultants have
  // a real branch dimension without wiping prior language coverage.
  const coords = await pool.query(
    `SELECT id FROM coordinators WHERE clinic_id = $1 AND branch_id IS NULL ORDER BY created_at`,
    [clinicId],
  );
  const branchIds = ins.rows.map((r) => r.id);
  for (let i = 0; i < coords.rows.length; i++) {
    await pool.query('UPDATE coordinators SET branch_id = $2 WHERE id = $1', [
      coords.rows[i].id,
      branchIds[i % branchIds.length],
    ]);
  }

  // Same for unassigned leads — language buckets keep the split readable in demos.
  const leads = await pool.query(
    `SELECT id, language FROM leads WHERE clinic_id = $1 AND branch_id IS NULL ORDER BY created_at`,
    [clinicId],
  );
  for (const lead of leads.rows) {
    let target = byCode.MAIN;
    if (lead.language === 'ar' || lead.language === 'en') target = byCode.NIS;
    else if (lead.language === 'de' || lead.language === 'ru') target = byCode.ATA;
    await pool.query('UPDATE leads SET branch_id = $2 WHERE id = $1', [lead.id, target]);
  }
  return true;
}

export async function setLeadBranch(leadId, branchId) {
  const bid = branchId == null || branchId === '' || branchId === 'none'
    ? null
    : normalizeBranchId(branchId);
  if (branchId && !bid && branchId !== 'none' && branchId !== '') {
    throw new Error('invalid branch_id');
  }
  if (bid) {
    const exists = await pool.query('SELECT id FROM branches WHERE id = $1 AND active', [bid]);
    if (!exists.rows[0]) throw new Error('branch not found');
  }
  const q = await pool.query(
    `UPDATE leads SET branch_id = $2, updated_at = now()
       WHERE id = $1 RETURNING id, branch_id`,
    [leadId, bid],
  );
  if (!q.rows[0]) throw new Error('lead not found');
  return q.rows[0];
}

// ── Partners (referral agents — Partner Portalı) ────────────────────────────
function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function listPartners() {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `SELECT id, name, email, commission_rate, active, created_at
       FROM partners WHERE clinic_id = $1 ORDER BY created_at DESC`,
    [clinicId],
  );
  return q.rows;
}

// The token is only ever returned here, at creation — same "shown once"
// discipline as any other API key. The panel must display and let the
// coordinator copy it immediately; it isn't retrievable afterwards.
// api_token (private, logs into the dashboard) and referral_code (public,
// safe to publish — only attributes a lead, see migration 022) are two
// different values on purpose: reusing one secret for both a login
// credential and a "share this everywhere" link is how that credential
// leaks.
export async function createPartner({ name, email, commissionRate }) {
  if (!name || !name.trim()) throw new Error('partner name is required');
  const clinicId = await getDefaultClinicId();
  const rate = commissionRate == null || commissionRate === '' ? 10 : Number(commissionRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('commissionRate must be between 0 and 100');
  const token = crypto.randomBytes(24).toString('hex');
  const referralCode = crypto.randomBytes(8).toString('hex');
  const q = await pool.query(
    `INSERT INTO partners (clinic_id, name, email, api_token, referral_code, commission_rate)
       VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, name, email, api_token, referral_code, commission_rate, active, created_at`,
    [clinicId, name.trim(), email || null, token, referralCode, rate],
  );
  return q.rows[0];
}

// Issues a fresh token and invalidates the old one in the same statement —
// the only recovery path when a partner loses theirs, since (like any API
// key) it's shown once at creation and never stored anywhere retrievable.
export async function updatePartner(partnerId, { name, email, commissionRate, active }) {
  const fields=[]; const vals=[partnerId];
  if (name !== undefined) {
    if (!name || !name.trim()) throw new Error('partner name is required');
    fields.push(`name = $${vals.push(name.trim().slice(0,120))}`);
  }
  if (email !== undefined) fields.push(`email = $${vals.push(email?.trim().slice(0,160) || null)}`);
  if (commissionRate !== undefined) {
    const rate = Number(commissionRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('commission rate must be between 0 and 100');
    fields.push(`commission_rate = $${vals.push(rate)}`);
  }
  if (active !== undefined) fields.push(`active = $${vals.push(Boolean(active))}`);
  if (!fields.length) throw new Error('nothing to update');
  const q = await pool.query(
    `UPDATE partners SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, name, email, commission_rate, active, created_at`, vals);
  if (!q.rows[0]) throw new Error('partner not found');
  return q.rows[0];
}

export async function deletePartner(partnerId) {
  // leads.partner_id is ON DELETE SET NULL, so the partner's referred patients
  // stay — they just stop being attributed, which also means their commission
  // stops accruing. Deliberately not blocked on having referrals: a partner
  // relationship that ends is a normal thing, and keeping the patients is the
  // point. Commission already paid is a matter of the clinic's own records.
  const q = await pool.query('DELETE FROM partners WHERE id = $1 RETURNING name', [partnerId]);
  if (!q.rows[0]) throw new Error('partner not found');
  return q.rows[0];
}

export async function regeneratePartnerToken(partnerId) {
  const token = crypto.randomBytes(24).toString('hex');
  const q = await pool.query(
    `UPDATE partners SET api_token = $2 WHERE id = $1 RETURNING id, name, api_token`,
    [partnerId, token],
  );
  if (!q.rows[0]) throw new Error('partner not found');
  return q.rows[0];
}

// Partner Portal auth lookup — deliberately not PANEL_API_TOKEN-gated (see
// src/routes/partner.js): each partner signs in with their own long random
// token instead of the clinic staff's shared panel token.
export async function getPartnerByToken(token) {
  if (!token) return null;
  const q = await pool.query(
    `SELECT id, name, commission_rate FROM partners WHERE api_token = $1 AND active`,
    [token],
  );
  return q.rows[0] || null;
}

// Widget lead attribution (?ref=<referral_code> — see createWidgetLead)
// deliberately does NOT use getPartnerByToken: the widget link is meant to
// be published everywhere, so it must never carry the same value that logs
// into the partner's private dashboard.
export async function getPartnerByReferralCode(code) {
  if (!code) return null;
  const q = await pool.query(
    `SELECT id, name, commission_rate FROM partners WHERE referral_code = $1 AND active`,
    [code],
  );
  return q.rows[0] || null;
}

export async function setLeadPartner(leadId, partnerId) {
  const pid = partnerId == null || partnerId === '' || partnerId === 'none' ? null : partnerId;
  if (pid && !isUuid(pid)) throw new Error('invalid partner_id');
  if (pid) {
    const exists = await pool.query('SELECT id FROM partners WHERE id = $1 AND active', [pid]);
    if (!exists.rows[0]) throw new Error('partner not found');
  }
  const q = await pool.query(
    `UPDATE leads SET partner_id = $2, updated_at = now() WHERE id = $1 RETURNING id, partner_id`,
    [leadId, pid],
  );
  if (!q.rows[0]) throw new Error('lead not found');
  return q.rows[0];
}

// What a partner sees in their own portal: every lead they referred, and what
// those leads have actually paid. Commission is earned on COLLECTED money
// only (payments.status = 'paid') — the same discipline getPaymentTotals()
// uses for clinic-side revenue, so a booked-but-unpaid lead earns nothing yet.
export async function getPartnerDashboard(partnerId) {
  const partnerQ = await pool.query(
    `SELECT id, name, commission_rate, referral_code FROM partners WHERE id = $1`,
    [partnerId],
  );
  if (!partnerQ.rows[0]) throw new Error('partner not found');
  const rate = Number(partnerQ.rows[0].commission_rate);

  const leadsQ = await pool.query(
    `SELECT l.id, l.name, l.country, l.treatment_interest, l.status, l.created_at
       FROM leads l WHERE l.partner_id = $1 ORDER BY l.created_at DESC`,
    [partnerId],
  );
  // Commission is money the clinic actually owes this partner — computed on
  // a plain sum(amount) across payments, it would silently add a TRY payment
  // and a EUR payment as if they were the same currency and pay the partner
  // several times their real EUR-equivalent commission the moment a referred
  // patient pays in a different currency than another (the normal case here,
  // since İyzico/TRY and Stripe/EUR-USD-GBP are both live by design). Each
  // payment is EUR-converted individually before it contributes to anything.
  const paymentsQ = await pool.query(
    `SELECT p.lead_id, p.amount, p.currency
       FROM payments p JOIN leads l ON l.id = p.lead_id
      WHERE l.partner_id = $1 AND p.status = 'paid'`,
    [partnerId],
  );
  const paidByLead = new Map();
  for (const r of paymentsQ.rows) {
    const eur = await toEur(Number(r.amount), r.currency);
    paidByLead.set(r.lead_id, (paidByLead.get(r.lead_id) || 0) + eur);
  }

  let totalPaid = 0;
  // Summed from the same per-lead figures the dashboard lists, rather than
  // recomputed from the grand total: rounding each line to cents and rounding
  // the total separately disagree by a few cents on realistic inputs, and this
  // is the number a partner reconciles their invoice against — line items that
  // don't add up to the stated total read as an error in the clinic's favour.
  let totalCommission = 0;
  const leads = leadsQ.rows.map((r) => {
    const paid = Math.round((paidByLead.get(r.id) || 0) * 100) / 100;
    const commission = Math.round(paid * rate) / 100;
    totalPaid += paid;
    totalCommission += commission;
    return { ...r, paid, commission };
  });

  return {
    partner: {
      id: partnerQ.rows[0].id,
      name: partnerQ.rows[0].name,
      commission_rate: rate,
      referral_code: partnerQ.rows[0].referral_code,
    },
    leads,
    total_paid: Math.round(totalPaid * 100) / 100,
    earned_commission: Math.round(totalCommission * 100) / 100,
  };
}

// ── Doctors (Doctor Portal — suitability review) ────────────────────────────
export async function listDoctors() {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `SELECT id, name, email, specialty, active, created_at
       FROM doctors WHERE clinic_id = $1 ORDER BY created_at DESC`,
    [clinicId],
  );
  return q.rows;
}

// Token shown once, same "copy it now" discipline as createPartner().
export async function createDoctor({ name, email, specialty }) {
  if (!name || !name.trim()) throw new Error('doctor name is required');
  const clinicId = await getDefaultClinicId();
  const token = crypto.randomBytes(24).toString('hex');
  const q = await pool.query(
    `INSERT INTO doctors (clinic_id, name, email, specialty, api_token)
       VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, email, specialty, api_token, active, created_at`,
    [clinicId, name.trim(), email || null, specialty || null, token],
  );
  return q.rows[0];
}

// Same recovery path as regeneratePartnerToken — the only way back when a
// doctor loses their token.
export async function updateDoctor(doctorId, { name, email, specialty, active }) {
  const fields=[]; const vals=[doctorId];
  if (name !== undefined) {
    if (!name || !name.trim()) throw new Error('doctor name is required');
    fields.push(`name = $${vals.push(name.trim().slice(0,120))}`);
  }
  if (email !== undefined) fields.push(`email = $${vals.push(email?.trim().slice(0,160) || null)}`);
  if (specialty !== undefined) fields.push(`specialty = $${vals.push(specialty?.trim().slice(0,120) || null)}`);
  if (active !== undefined) fields.push(`active = $${vals.push(Boolean(active))}`);
  if (!fields.length) throw new Error('nothing to update');
  const q = await pool.query(
    `UPDATE doctors SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, name, email, specialty, active, created_at`, vals);
  if (!q.rows[0]) throw new Error('doctor not found');
  return q.rows[0];
}

export async function deleteDoctor(doctorId) {
  // leads.doctor_id is ON DELETE SET NULL — a departing doctor's reviews stay
  // on the patient record (doctor_review_status / the note they wrote), the
  // patients simply become unassigned and can be handed to someone else.
  const q = await pool.query('DELETE FROM doctors WHERE id = $1 RETURNING name', [doctorId]);
  if (!q.rows[0]) throw new Error('doctor not found');
  return q.rows[0];
}

export async function regenerateDoctorToken(doctorId) {
  const token = crypto.randomBytes(24).toString('hex');
  const q = await pool.query(
    `UPDATE doctors SET api_token = $2 WHERE id = $1 RETURNING id, name, api_token`,
    [doctorId, token],
  );
  if (!q.rows[0]) throw new Error('doctor not found');
  return q.rows[0];
}

// Doctor Portal auth lookup — like getPartnerByToken, not PANEL_API_TOKEN-gated.
export async function getDoctorByToken(token) {
  if (!token) return null;
  const q = await pool.query(`SELECT id, name FROM doctors WHERE api_token = $1 AND active`, [token]);
  return q.rows[0] || null;
}

export async function setLeadDoctor(leadId, doctorId) {
  const did = doctorId == null || doctorId === '' || doctorId === 'none' ? null : doctorId;
  if (did && !isUuid(did)) throw new Error('invalid doctor_id');
  if (did) {
    const exists = await pool.query('SELECT id FROM doctors WHERE id = $1 AND active', [did]);
    if (!exists.rows[0]) throw new Error('doctor not found');
  }
  // Assigning a doctor starts their review at 'pending'. Only reset when the
  // doctor is actually CHANGING to someone new (leads.doctor_id, read here as
  // the pre-update value, differs from the new $2) — a redundant re-set to
  // the same doctor must not wipe out a review already in progress. But a
  // genuine reassignment to a different doctor must: otherwise the new
  // doctor's portal shows the PREVIOUS doctor's approval/note as if they'd
  // already reviewed a case they've never seen.
  const q = await pool.query(
    `UPDATE leads
        SET doctor_id = $2,
            doctor_review_status = CASE
              WHEN $2::uuid IS NULL THEN doctor_review_status
              WHEN leads.doctor_id IS DISTINCT FROM $2 THEN 'pending'
              ELSE doctor_review_status
            END,
            doctor_note = CASE
              WHEN $2::uuid IS NOT NULL AND leads.doctor_id IS DISTINCT FROM $2 THEN NULL
              ELSE doctor_note
            END,
            doctor_reviewed_at = CASE
              WHEN $2::uuid IS NOT NULL AND leads.doctor_id IS DISTINCT FROM $2 THEN NULL
              ELSE doctor_reviewed_at
            END,
            updated_at = now()
      WHERE id = $1 RETURNING id, doctor_id`,
    [leadId, did],
  );
  if (!q.rows[0]) throw new Error('lead not found');
  return q.rows[0];
}

// What a doctor sees in their portal's list: everyone currently assigned to them.
export async function getDoctorLeads(doctorId) {
  const q = await pool.query(
    `SELECT id, name, country, treatment_interest, budget_hint,
            doctor_review_status, doctor_note, doctor_reviewed_at, created_at
       FROM leads WHERE doctor_id = $1 ORDER BY created_at DESC`,
    [doctorId],
  );
  return q.rows;
}

// One patient's detail for the doctor — the WHERE doctor_id = $2 is the
// access check: a doctor can only ever open a lead assigned to them.
export async function getDoctorLeadDetail(doctorId, leadId) {
  const leadQ = await pool.query(
    `SELECT id, name, country, language, treatment_interest, budget_hint,
            doctor_review_status, doctor_note, doctor_reviewed_at
       FROM leads WHERE id = $1 AND doctor_id = $2`,
    [leadId, doctorId],
  );
  if (!leadQ.rows[0]) return null;
  const convQ = await pool.query('SELECT id FROM conversations WHERE lead_id = $1', [leadId]);
  let messages = [];
  if (convQ.rows[0]) {
    const msgQ = await pool.query(
      `SELECT id, role, content, created_at, (media_mime_type IS NOT NULL) AS has_media
         FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [convQ.rows[0].id],
    );
    messages = msgQ.rows;
  }
  return { lead: leadQ.rows[0], messages };
}

// Doctor-scoped photo fetch — the join back to doctor_id is what stops one
// doctor from pulling another doctor's patient's photo by guessing a message id.
export async function getDoctorMessageMedia(doctorId, leadId, messageId) {
  const q = await pool.query(
    `SELECT m.media_data, m.media_mime_type
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN leads l ON l.id = c.lead_id
      WHERE m.id = $1 AND l.id = $2 AND l.doctor_id = $3 AND m.media_data IS NOT NULL`,
    [messageId, leadId, doctorId],
  );
  return q.rows[0] || null;
}

export async function submitDoctorReview(doctorId, leadId, { status, note }) {
  if (!['approved', 'needs_info'].includes(status)) throw new Error('invalid status');
  const q = await pool.query(
    `UPDATE leads SET doctor_review_status = $3, doctor_note = $4, doctor_reviewed_at = now(), updated_at = now()
       WHERE id = $1 AND doctor_id = $2
     RETURNING id, doctor_review_status`,
    [leadId, doctorId, status, (note || '').trim().slice(0, 2000) || null],
  );
  if (!q.rows[0]) throw new Error('lead not found or not assigned to you');
  return q.rows[0];
}

// Route a lead to the least-loaded active coordinator who speaks its language.
// Prefer same-şube coordinators when the lead already has a branch_id; fall
// back to any language match so the AI bridge behaviour is unchanged.
export async function assignCoordinatorByLanguage(leadId, langCode) {
  if (!langCode) return null;
  const existing = await pool.query('SELECT coordinator_id, branch_id FROM leads WHERE id = $1', [leadId]);
  if (existing.rows[0]?.coordinator_id) return existing.rows[0].coordinator_id;
  const leadBranch = existing.rows[0]?.branch_id || null;

  const pick = await pool.query(
    `SELECT co.id, count(l.id) AS load,
            CASE WHEN $2::uuid IS NOT NULL AND co.branch_id = $2 THEN 0 ELSE 1 END AS branch_rank
       FROM coordinators co
       LEFT JOIN leads l ON l.coordinator_id = co.id
      WHERE co.active AND $1 = ANY(co.languages)
      GROUP BY co.id
      ORDER BY branch_rank ASC, load ASC
      LIMIT 1`,
    [langCode, leadBranch],
  );
  const coordinatorId = pick.rows[0]?.id;
  if (!coordinatorId) return null;

  await pool.query(
    `UPDATE leads SET coordinator_id = $2, updated_at = now()
       WHERE id = $1 AND coordinator_id IS NULL`,
    [leadId, coordinatorId],
  );
  return coordinatorId;
}

export async function getConsultantMetrics({ branchId = null } = {}) {
  const bid = normalizeBranchId(branchId);
  const coords = await pool.query(
    `
    SELECT co.id, co.name, co.languages, co.active, co.branch_id,
      count(l.id) FILTER (WHERE ($1::uuid IS NULL OR l.branch_id = $1)) AS assigned,
      count(l.id) FILTER (WHERE l.status='hot' AND ($1::uuid IS NULL OR l.branch_id = $1)) AS hot,
      count(l.id) FILTER (WHERE l.status='handed_over' AND ($1::uuid IS NULL OR l.branch_id = $1)) AS handed_over,
      count(l.id) FILTER (WHERE l.status='booked' AND ($1::uuid IS NULL OR l.branch_id = $1)) AS booked
    FROM coordinators co
    LEFT JOIN leads l ON l.coordinator_id = co.id
    WHERE ($1::uuid IS NULL OR co.branch_id = $1 OR co.branch_id IS NULL)
    GROUP BY co.id
    ORDER BY assigned DESC, co.name
  `,
    [bid],
  );
  // Languages present in leads that NO active coordinator can serve.
  const gaps = await pool.query(
    `
    SELECT DISTINCT l.language
    FROM leads l
    WHERE l.language IS NOT NULL
      AND ($1::uuid IS NULL OR l.branch_id = $1)
      AND NOT EXISTS (
        SELECT 1 FROM coordinators c WHERE c.active AND l.language = ANY(c.languages)
      )
  `,
    [bid],
  );
  return {
    coordinators: coords.rows.map((c) => {
      const assigned = Number(c.assigned);
      return { ...c, conversion: assigned ? Math.round((Number(c.booked) / assigned) * 100) : null };
    }),
    unmatched_languages: gaps.rows.map((r) => r.language),
  };
}

// ── Post-Op & Trust/Review (Modül 8+9) ──────────────────────────────────────
const POST_OP_SEQUENCE = [
  { kind: 'thank_you',      days: 0 },
  { kind: 'review_request', days: 2 },
  { kind: 'checkin_7',      days: 7 },
  { kind: 'checkin_30',     days: 30 },
  { kind: 'fit_to_fly',     days: 3 },
  { kind: 'checkup_1y',     days: 365 },
];

export async function schedulePostOp(leadId) {
  const clinicId = await getDefaultClinicId();
  // Avoid double-scheduling.
  const existing = await pool.query('SELECT count(*)::int AS n FROM post_op_tasks WHERE lead_id = $1', [leadId]);
  if (existing.rows[0].n > 0) return 0;
  let inserted = 0;
  for (const step of POST_OP_SEQUENCE) {
    await pool.query(
      `INSERT INTO post_op_tasks (clinic_id, lead_id, kind, due_at)
         VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)`,
      [clinicId, leadId, step.kind, String(step.days)],
    );
    inserted += 1;
  }
  await pool.query(`UPDATE leads SET status='booked', updated_at=now() WHERE id=$1`, [leadId]);
  return inserted;
}

export async function getDuePostOpTasks() {
  // WhatsApp template sends only — a lead with no phone (Instagram/Messenger)
  // can't receive one, so it's excluded rather than left to fail send-side.
  const q = await pool.query(`
    SELECT t.id, t.kind, t.lead_id, l.phone, l.name, l.language
    FROM post_op_tasks t JOIN leads l ON l.id = t.lead_id
    WHERE t.status='pending' AND t.due_at <= now() AND l.phone IS NOT NULL
    ORDER BY t.due_at LIMIT 50
  `);
  return q.rows;
}
// Atomic claim: WHERE status='pending' means only one caller can ever win a
// given row, even if two scheduler runs overlap (a slow tick plus the next
// one, or local dev racing Vercel Cron against the same database). Returns
// false when another run already claimed it, so the caller knows to skip
// the send rather than deliver it a second time.
export async function markPostOpSent(id) {
  const q = await pool.query(`UPDATE post_op_tasks SET status='sent' WHERE id=$1 AND status='pending' RETURNING id`, [id]);
  return Boolean(q.rows[0]);
}

export async function getPostOpOverview() {
  const q = await pool.query(`
    SELECT l.id AS lead_id, l.name, l.phone, l.source, l.external_id,
      json_agg(json_build_object('kind',t.kind,'due_at',t.due_at,'status',t.status) ORDER BY t.due_at) AS tasks
    FROM post_op_tasks t JOIN leads l ON l.id = t.lead_id
    GROUP BY l.id ORDER BY max(t.created_at) DESC
  `);
  return q.rows;
}

export async function getReviewStats() {
  const q = await pool.query(`
    SELECT
      count(*) FILTER (WHERE kind='review_request') AS invites,
      count(*) FILTER (WHERE kind='review_request' AND status='sent') AS sent
    FROM post_op_tasks
  `);
  const row = q.rows[0];
  // There is no review-platform integration yet, so there is no reputation
  // score to report. The old value was generated from the invite count — it
  // moved with the data, which made it read as measured. null is honest; the
  // panel shows a dash and says what's missing.
  return { invites: Number(row.invites), sent: Number(row.sent), rating: null };
}

// ── Smart Device Booking (Modül 3) ──────────────────────────────────────────
// ── Device management ───────────────────────────────────────────────────────
// The booking grid reads from this table, so a clinic that can't add its own
// rooms and chairs can only ever book the demo ones.
const DEVICE_TYPES = ['operating_room', 'device', 'chair'];

export async function listAllDevices() {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `SELECT id, name, type, active FROM devices
      WHERE clinic_id = $1 ORDER BY active DESC, name`,
    [clinicId],
  );
  return q.rows;
}

export async function createDevice({ name, type }) {
  if (!name || !name.trim()) throw new Error('device name is required');
  if (type && !DEVICE_TYPES.includes(type)) throw new Error('invalid device type');
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `INSERT INTO devices (clinic_id, name, type) VALUES ($1,$2,$3)
     RETURNING id, name, type, active`,
    [clinicId, name.trim().slice(0, 120), type || 'device'],
  );
  return q.rows[0];
}

export async function updateDevice(id, { name, type, active }) {
  const fields = [];
  const vals = [id];
  if (name !== undefined) {
    if (!name || !name.trim()) throw new Error('device name is required');
    fields.push(`name = $${vals.push(name.trim().slice(0, 120))}`);
  }
  if (type !== undefined) {
    if (!DEVICE_TYPES.includes(type)) throw new Error('invalid device type');
    fields.push(`type = $${vals.push(type)}`);
  }
  if (active !== undefined) fields.push(`active = $${vals.push(Boolean(active))}`);
  if (!fields.length) throw new Error('nothing to update');

  const q = await pool.query(
    `UPDATE devices SET ${fields.join(', ')} WHERE id = $1 RETURNING id, name, type, active`,
    vals,
  );
  if (!q.rows[0]) throw new Error('device not found');
  return q.rows[0];
}

// ── Appointments (Smart Device Booking — the booked slots themselves) ───────
// Booking existed from the start; seeing and undoing a booking did not, which
// meant a slot picked by mistake stayed on the grid forever and kept counting
// against that room's utilization.
export async function listAppointments({ deviceId = null, includePast = false } = {}) {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `SELECT a.id, a.device_id, d.name AS device_name, a.lead_id, l.name AS lead_name,
            l.phone AS lead_phone, l.source AS lead_source, a.starts_at, a.ends_at, a.status
       FROM appointments a
       JOIN devices d ON d.id = a.device_id
       LEFT JOIN leads l ON l.id = a.lead_id
      WHERE a.clinic_id = $1
        AND ($2::uuid IS NULL OR a.device_id = $2)
        AND ($3::boolean OR a.starts_at > now() - interval '1 day')
      ORDER BY a.starts_at`,
    [clinicId, deviceId, includePast],
  );
  return q.rows;
}

export async function cancelAppointment(id) {
  // Cancel rather than delete: the slot stops blocking the room, but the fact
  // that it was booked and dropped stays visible — that is the signal the
  // no-show model and the utilization history are built on.
  const q = await pool.query(
    `UPDATE appointments SET status = 'cancelled' WHERE id = $1 AND status <> 'cancelled'
     RETURNING id, starts_at, status`,
    [id],
  );
  if (!q.rows[0]) throw new Error('appointment not found or already cancelled');
  return q.rows[0];
}

export async function deleteAppointment(id) {
  const q = await pool.query('DELETE FROM appointments WHERE id = $1 RETURNING id, starts_at', [id]);
  if (!q.rows[0]) throw new Error('appointment not found');
  return q.rows[0];
}

export async function deleteDevice(id) {
  // appointments.device_id cascades, so deleting a room silently deletes every
  // booking on it. A past booking is history worth losing when the room is
  // gone; a FUTURE one is a patient with an appointment nobody will honour, so
  // that case is refused and the operator is told to move or cancel first.
  const upcoming = await pool.query(
    `SELECT count(*)::int AS n FROM appointments WHERE device_id = $1 AND starts_at > now()`,
    [id],
  );
  if (upcoming.rows[0].n > 0) {
    throw new Error(`this room has ${upcoming.rows[0].n} upcoming appointment(s) — move or cancel them first`);
  }
  const q = await pool.query('DELETE FROM devices WHERE id = $1 RETURNING name', [id]);
  if (!q.rows[0]) throw new Error('device not found');
  return q.rows[0];
}

export async function seedDevicesIfEmpty() {
  const c = await pool.query('SELECT count(*)::int AS n FROM devices');
  if (c.rows[0].n > 0) return false;
  const clinicId = await getDefaultClinicId();
  await pool.query(
    `INSERT INTO devices (clinic_id, name, type) VALUES
      ($1,'Operating Room A','operating_room'),
      ($1,'Operating Room B','operating_room'),
      ($1,'FUE Suite 1','device'),
      ($1,'Dental Chair 1','chair')`,
    [clinicId],
  );
  return true;
}

export async function getDevicesWithUtilization() {
  // Same clinic-timezone bucketing as getStats()/getAnalytics() — see their
  // comments for why a plain now()::date comparison is wrong here too.
  const q = await pool.query(
    `
    SELECT d.id, d.name, d.type,
      count(a.id) FILTER (WHERE (a.starts_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date AND a.status='booked') AS today_booked
    FROM devices d
    LEFT JOIN appointments a ON a.device_id = d.id
    WHERE d.active GROUP BY d.id ORDER BY d.name
  `,
    [BUSINESS_HOURS.timezone],
  );
  return q.rows.map((r) => ({
    ...r,
    slots: SLOTS_PER_DAY,
    utilization: Math.round((Number(r.today_booked) / SLOTS_PER_DAY) * 100),
  }));
}

// Hot/booked leads that don't yet have an appointment — the waiting list.
export async function getWaitingList() {
  const q = await pool.query(`
    SELECT l.id, l.name, l.phone, l.treatment_interest, l.score, l.source, l.external_id
    FROM leads l
    WHERE l.status IN ('hot','booked')
      AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id AND a.status='booked')
    ORDER BY l.score DESC NULLS LAST LIMIT 20
  `);
  return q.rows;
}

export async function bookAppointment(deviceId, leadId, startsAt, endsAt) {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `INSERT INTO appointments (clinic_id, device_id, lead_id, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, starts_at, ends_at`,
    [clinicId, deviceId, leadId, startsAt, endsAt],
  );
  return q.rows[0];
}

// ── VIP Transfer & Logistics (Modül 6) ──────────────────────────────────────
export async function getLogistics() {
  const q = await pool.query(`
    SELECT lo.lead_id, l.name, l.phone, l.country, l.language, l.source, l.external_id,
      lo.flight_no, lo.arrival_at, lo.transfer_status, lo.hotel_status, lo.appointment_status,
      lo.pickup_at, lo.pickup_location, lo.next_appointment_at, lo.next_appointment_note, lo.view_token
    FROM logistics lo JOIN leads l ON l.id = lo.lead_id
    ORDER BY lo.updated_at DESC
  `);
  return q.rows;
}

// Matches the panel's own STAGES dropdown (public/index.html LogisticsCard).
// Enforced here, not just client-side: these three fields render on the
// patient-facing itinerary page, and itinerary.html falls back to
// interpolating the raw value un-escaped for anything it doesn't recognize
// as one of these — an unvalidated value posted straight to this API would
// otherwise become a stored XSS on that page for whichever patient opens
// their tracking link next.
const LOGISTICS_STAGES = {
  transfer_status: new Set(['pending', 'arranged', 'completed']),
  hotel_status: new Set(['pending', 'checked_in', 'checked_out']),
  appointment_status: new Set(['pending', 'scheduled', 'done']),
};
function assertValidStage(field, value) {
  if (value != null && !LOGISTICS_STAGES[field].has(value)) {
    throw new Error(`invalid ${field} — use one of ${[...LOGISTICS_STAGES[field]].join(', ')}`);
  }
}

export async function upsertLogistics(leadId, d) {
  assertValidStage('transfer_status', d.transfer_status || null);
  assertValidStage('hotel_status', d.hotel_status || null);
  assertValidStage('appointment_status', d.appointment_status || null);
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `INSERT INTO logistics (
       clinic_id, lead_id, flight_no, arrival_at, transfer_status, hotel_status, appointment_status,
       pickup_at, pickup_location, next_appointment_at, next_appointment_note, updated_at
     )
       VALUES ($1,$2,$3,$4,COALESCE($5,'pending'),COALESCE($6,'pending'),COALESCE($7,'pending'),$8,$9,$10,$11, now())
     ON CONFLICT (lead_id) DO UPDATE SET
       flight_no = COALESCE(EXCLUDED.flight_no, logistics.flight_no),
       arrival_at = COALESCE(EXCLUDED.arrival_at, logistics.arrival_at),
       transfer_status = COALESCE($5, logistics.transfer_status),
       hotel_status = COALESCE($6, logistics.hotel_status),
       appointment_status = COALESCE($7, logistics.appointment_status),
       pickup_at = COALESCE($8, logistics.pickup_at),
       pickup_location = COALESCE($9, logistics.pickup_location),
       next_appointment_at = COALESCE($10, logistics.next_appointment_at),
       next_appointment_note = COALESCE($11, logistics.next_appointment_note),
       updated_at = now()
     RETURNING lead_id, view_token`,
    [clinicId, leadId, d.flight_no || null, d.arrival_at || null,
     d.transfer_status || null, d.hotel_status || null, d.appointment_status || null,
     d.pickup_at || null, d.pickup_location || null, d.next_appointment_at || null, d.next_appointment_note || null],
  );
  return q.rows[0];
}

// The patient-facing view — no auth (same "unpredictable token instead of a
// login" pattern as the quote tracking link), so it only ever returns what a
// patient should see: their own schedule, not internal fields like status
// history or which coordinator is assigned.
export async function getLogisticsByToken(token) {
  const q = await pool.query(
    `SELECT lo.transfer_status, lo.hotel_status, lo.appointment_status,
            lo.pickup_at, lo.pickup_location, lo.next_appointment_at, lo.next_appointment_note,
            l.name, l.language
       FROM logistics lo JOIN leads l ON l.id = lo.lead_id
      WHERE lo.view_token = $1`,
    [token],
  );
  return q.rows[0] || null;
}

// ── Sesli AI Konsiyerj (Voice AI Call Center) ──────────────────────────────
// Mevcut leads/conversations şemasına dokunmadan, aynı eşleme anahtarını
// (clinic_id, phone) ve aynı "tek conversations satırı" garantisini kullanır
// — bkz. loadContext()/createWidgetLead() yukarıda, aynı desen.

/**
 * Bir aramanın lead'ini bul/oluştur VE bu lead için bir conversations
 * satırının var olduğunu garantile (markConversationEscalated() yukarıda
 * bir satır bulamazsa sessizce hiçbir şey yapmaz — bu yüzden burada önceden
 * garanti ediyoruz, tıpkı metin/widget kanallarının zaten yaptığı gibi).
 * WhatsApp'tan tanınan bir numara aradığında otomatik olarak AYNI lead'e
 * bağlanır — başka bir birleştirme kodu gerekmez.
 */
export async function resolveLeadForCall(phone, branchId = null) {
  const clinicId = await getDefaultClinicId();
  const bid = normalizeBranchId(branchId);
  const leadRes = await pool.query(
    `INSERT INTO leads (clinic_id, phone, branch_id)
       VALUES ($1, $2, $3)
     ON CONFLICT (clinic_id, phone) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [clinicId, phone, bid],
  );
  const leadId = leadRes.rows[0].id;
  await pool.query(
    `INSERT INTO conversations (clinic_id, lead_id, channel)
       VALUES ($1, $2, 'voice')
     ON CONFLICT (lead_id) DO UPDATE SET updated_at = now()`,
    [clinicId, leadId],
  );
  return leadId;
}

/**
 * Create the `calls` row the instant a call starts. Idempotent on
 * provider_call_id (Twilio's CallSid) — a redelivered webhook for the same
 * call returns the SAME id rather than erroring or duplicating, same
 * fault-tolerance requirement as idx_messages_wamid/idx_payments_provider_session.
 */
export async function createCall({ branchId, leadId, providerCallId, direction }) {
  const clinicId = await getDefaultClinicId();
  const ins = await pool.query(
    `INSERT INTO calls (clinic_id, branch_id, lead_id, provider_call_id, direction)
       VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (provider_call_id) DO NOTHING
     RETURNING id`,
    [clinicId, normalizeBranchId(branchId), leadId || null, providerCallId, direction],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  const existing = await pool.query('SELECT id FROM calls WHERE provider_call_id = $1', [providerCallId]);
  return existing.rows[0]?.id || null;
}

// Written incrementally, every turn — not just at call-end — so a hard kill
// mid-call (a voice-server.js redeploy, a crash) loses at most the one
// in-flight turn, never the transcript-so-far (bkz. approved plan, Deployment).
export async function appendCallTurn(callId, { role, transcript, isSafetyNet = false, latencyMs = null }) {
  await pool.query(
    `INSERT INTO call_turns (call_id, role, transcript, is_safety_net, latency_ms)
       VALUES ($1,$2,$3,$4,$5)`,
    [callId, role, transcript, Boolean(isSafetyNet), latencyMs || null],
  );
}

/**
 * Close out a call: final status/outcome/summary, frozen cost breakdown
 * (computed by src/voice/costs.js at the time the call ended — a later
 * pricing-config change must never rewrite a past call's historical cost,
 * which is exactly why the number is stored here rather than recomputed on
 * read). Lead-scoring/handover update is a SEPARATE call to applyLeadSignal()
 * (above) — session.js calls both, not bundled into one function, because a
 * mid-call safety trigger needs applyLeadSignal() alone, before the call
 * has actually ended.
 */
export async function finalizeCall(callId, {
  status, outcome, summary, language, usage = {}, costBreakdown = null, totalCostUsd = null,
  recordingConsent = null, recordingUrl = null,
} = {}) {
  const q = await pool.query(
    `UPDATE calls SET
       status = COALESCE($2, status),
       ended_at = now(),
       duration_s = EXTRACT(EPOCH FROM (now() - started_at))::int,
       outcome = COALESCE($3, outcome),
       summary = COALESCE($4, summary),
       language = COALESCE($5, language),
       telephony_seconds = $6, stt_seconds = $7,
       llm_input_tokens = $8, llm_output_tokens = $9, llm_cached_read_tokens = $10,
       tts_characters = $11,
       cost_breakdown = $12, total_cost_usd = $13,
       recording_consent = COALESCE($14, recording_consent),
       recording_url = COALESCE($15, recording_url),
       updated_at = now()
     WHERE id = $1
     RETURNING id, lead_id, clinic_id, status, duration_s, total_cost_usd`,
    [
      callId, status || null, outcome || null, summary || null, language || null,
      Number(usage.telephonySeconds) || 0, Number(usage.sttSeconds) || 0,
      Number(usage.llmInputTokens) || 0, Number(usage.llmOutputTokens) || 0, Number(usage.llmCachedReadTokens) || 0,
      Number(usage.ttsCharacters) || 0,
      costBreakdown ? JSON.stringify(costBreakdown) : null, totalCostUsd,
      recordingConsent, recordingUrl,
    ],
  );
  if (!q.rows[0]) throw new Error('call not found');
  return q.rows[0];
}
