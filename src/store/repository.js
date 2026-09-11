import { pool } from '../db/pool.js';

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

/**
 * Resolve the lead + conversation for an inbound WhatsApp message and return
 * the prior message history for AI context. Also performs idempotency dedup:
 * if this exact Meta message id was already stored, returns { duplicate: true }
 * so the caller can skip re-processing (Meta retries webhooks).
 */
export async function loadContext(phone, { name, wamid }) {
  const clinicId = await getDefaultClinicId();

  if (wamid) {
    const dup = await pool.query(
      'SELECT 1 FROM messages WHERE whatsapp_message_id = $1 LIMIT 1',
      [wamid],
    );
    if (dup.rowCount > 0) return { duplicate: true, history: [], ctx: {} };
  }

  // Upsert lead by (clinic, phone). Don't overwrite an existing name with null.
  const leadRes = await pool.query(
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

  // Recent history for the model (chronological). Cap to keep prompts bounded.
  const histRes = await pool.query(
    `SELECT role, content FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT 40`,
    [conversationId],
  );

  return {
    duplicate: false,
    history: histRes.rows.map((r) => ({ role: r.role, content: r.content })),
    ctx: { clinicId, leadId, conversationId, conversationStatus },
  };
}

/**
 * Persist one full exchange (patient message + assistant reply), update the
 * lead from the AI's structured insight, and flag handover when needed.
 * All in one transaction so a lead is never left half-updated.
 */
export async function saveExchange(phone, { userText, inboundWamid, reply, meta, ctx }) {
  const { leadId, conversationId } = ctx;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Inbound message — carries the Meta id for idempotency. If a retry already
    // inserted it, DO NOTHING keeps this safe.
    await client.query(
      `INSERT INTO messages (conversation_id, role, content, whatsapp_message_id)
         VALUES ($1, 'user', $2, $3)
       ON CONFLICT (whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL
       DO NOTHING`,
      [conversationId, userText, inboundWamid || null],
    );

    // Assistant reply.
    await client.query(
      `INSERT INTO messages (conversation_id, role, content)
         VALUES ($1, 'assistant', $2)`,
      [conversationId, reply],
    );

    // Update the lead from the AI's structured read of the conversation.
    if (meta) {
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
        const urgent = Boolean(meta.handover?.urgent);
        await client.query(
          `UPDATE conversations
             SET status = 'needs_human', handover_reason = $2, urgent = urgent OR $3, updated_at = now()
           WHERE id = $1`,
          [conversationId, meta.handover.reason || 'unspecified', urgent],
        );
      }
    }

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
            budget_hint, readiness, score, status, crm_lead_id
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

// Save only the inbound patient message (used when a human agent has taken over
// the conversation, so the AI does not auto-reply).
export async function saveInboundMessage(ctx, { userText, wamid }) {
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content, whatsapp_message_id)
       VALUES ($1, 'user', $2, $3)
     ON CONFLICT (whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL
     DO NOTHING`,
    [ctx.conversationId, userText, wamid || null],
  );
}

// Command Center KPIs (real numbers from the DB; a couple of demo constants
// come from the frontend, clearly labelled there).
// Both the Command Center's occupancy KPI and the Smart Device Booking view
// derive utilisation from this one assumption, so the two screens can't drift.
export const SLOTS_PER_DAY = 6;

export async function getStats() {
  const q = await pool.query(`
    SELECT
      (SELECT count(*) FROM leads)                                            AS total_leads,
      (SELECT count(*) FROM leads WHERE created_at::date = now()::date)       AS today_leads,
      (SELECT count(*) FROM leads WHERE status = 'hot')                       AS hot_leads,
      (SELECT count(*) FROM leads WHERE status = 'handed_over')               AS handed_over,
      (SELECT count(*) FROM conversations WHERE status = 'needs_human')       AS needs_human,
      (SELECT count(DISTINCT country) FROM leads WHERE country IS NOT NULL)   AS countries,
      (SELECT count(*) FROM leads WHERE country IS NOT NULL)                  AS with_country,
      -- Share of conversations the AI is still handling on its own. This is a
      -- real autonomy figure, unlike a "booking rate", which needs the payment
      -- data we don't collect yet.
      (SELECT count(*) FROM conversations WHERE status = 'ai_handling')        AS ai_handled,
      (SELECT count(*) FROM conversations)                                     AS total_conversations,
      -- Today's average device utilisation, same maths as the booking view.
      (SELECT COALESCE(round(avg(u.util)), 0) FROM (
         SELECT (count(a.id) FILTER (WHERE a.starts_at::date = now()::date AND a.status = 'booked')::numeric
                 / ${SLOTS_PER_DAY}) * 100 AS util
         FROM devices d LEFT JOIN appointments a ON a.device_id = d.id
         WHERE d.active GROUP BY d.id
       ) u)                                                                    AS device_occupancy
  `);
  const row = q.rows[0];
  const convs = Number(row.total_conversations);
  return {
    ...row,
    ai_autonomy: convs ? Math.round((Number(row.ai_handled) / convs) * 100) : null,
  };
}

// Inbox: one row per conversation with lead info + last message preview.
export async function listConversations() {
  const q = await pool.query(`
    SELECT
      l.id                AS lead_id,
      l.phone, l.name, l.country, l.language, l.score, l.status AS lead_status,
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
    ORDER BY lm.created_at DESC NULLS LAST
    LIMIT 100
  `);
  return q.rows;
}

// The Action Center handover queue.
export async function getHandoverQueue() {
  const q = await pool.query(`
    SELECT l.id AS lead_id, l.phone, l.name, l.country, l.language, l.score, l.medical_note,
           c.handover_reason, c.urgent, c.updated_at
    FROM conversations c
    JOIN leads l ON l.id = c.lead_id
    WHERE c.status = 'needs_human'
    ORDER BY c.urgent DESC, l.score DESC NULLS LAST, c.updated_at DESC
  `);
  return q.rows;
}

// Full thread for one lead.
export async function getConversationDetail(leadId) {
  const leadQ = await pool.query(
    `SELECT id, phone, name, country, language, treatment_interest, budget_hint,
            readiness, score, status, crm_lead_id, medical_note
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
      `SELECT role, content, created_at FROM messages
         WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversation.id],
    );
    messages = msgQ.rows;
  }
  // Internal coordinator notes travel with the detail so the profile panel
  // needs one request, not two.
  const notes = await listLeadNotes(leadId);
  const payments = await listPaymentsForLead(leadId);
  return { lead, conversation, messages, notes, payments };
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

// ── Payments ─────────────────────────────────────────────────────────────
// The one thing every other "real" number in this app depends on. Revenue,
// ROAS and commission are honest only once they are a sum over rows here,
// not a count of booked leads times an assumed average.
export async function listPaymentsForLead(leadId) {
  const q = await pool.query(
    `SELECT id, amount, currency, type, status, due_date, paid_at,
            reminder_sent_at, note, created_at, updated_at
       FROM payments WHERE lead_id = $1 ORDER BY created_at DESC`,
    [leadId],
  );
  return q.rows;
}

export async function createPayment(leadId, { amount, currency, type, dueDate, note }) {
  const clinicId = await getDefaultClinicId();
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
  const q = await pool.query(
    `INSERT INTO payments (clinic_id, lead_id, amount, currency, type, due_date, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, amount, currency, type, status, due_date, paid_at,
               reminder_sent_at, note, created_at, updated_at`,
    [clinicId, leadId, amt, (currency || 'EUR').toUpperCase().slice(0, 3), type || 'deposit', dueDate || null, note || null],
  );
  return q.rows[0];
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
     RETURNING id, lead_id, amount, currency, type, status, due_date, paid_at,
               reminder_sent_at, note, created_at, updated_at`,
    vals,
  );
  if (!q.rows[0]) throw new Error('payment not found');
  return q.rows[0];
}

// Cross-lead view for the Inbox's "Awaiting deposit" filter and any future
// dunning list — every lead with at least one payment still pending.
export async function listPendingDeposits() {
  const q = await pool.query(`
    SELECT p.lead_id, count(*)::int AS pending_count,
           sum(p.amount) AS pending_amount, min(p.currency) AS currency,
           min(p.due_date) AS earliest_due, max(p.reminder_sent_at) AS last_reminder
      FROM payments p WHERE p.status = 'pending'
     GROUP BY p.lead_id
  `);
  return q.rows.map((r) => ({ ...r, pending_amount: Number(r.pending_amount) }));
}

// The real revenue figure: money actually marked paid. Booked-but-unpaid
// leads contribute nothing here — as they shouldn't.
export async function getPaymentTotals() {
  const q = await pool.query(`
    SELECT
      COALESCE(sum(amount) FILTER (WHERE status = 'paid'), 0)    AS collected,
      COALESCE(sum(amount) FILTER (WHERE status = 'pending'), 0) AS pending,
      count(*) FILTER (WHERE status = 'pending')                 AS pending_count
    FROM payments
  `);
  const r = q.rows[0];
  return { collected: Number(r.collected), pending: Number(r.pending), pending_count: Number(r.pending_count) };
}

// Set a conversation's status (takeover / hand back to AI / close).
export async function setConversationStatus(leadId, status) {
  const q = await pool.query(
    `UPDATE conversations SET status = $2, updated_at = now()
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
    `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
    [conv.id, content],
  );
  return conv.id;
}

// Look up a lead's phone (the panel sends replies by lead id).
export async function getLeadPhone(leadId) {
  const q = await pool.query(`SELECT phone FROM leads WHERE id = $1`, [leadId]);
  return q.rows[0]?.phone || null;
}

// ── Lead Collection Widget ──────────────────────────────────────────────────
// Create a lead from a web widget submission and open a conversation with the
// patient's inquiry as the first message. Feeds the same pipeline as WhatsApp.
export async function createWidgetLead(d) {
  const clinicId = await getDefaultClinicId();
  const leadRes = await pool.query(
    `INSERT INTO leads (clinic_id, phone, name, country, language, treatment_interest, budget_hint, source, status, consent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'widget','new',$8)
     ON CONFLICT (clinic_id, phone) DO UPDATE SET
       name = COALESCE(leads.name, EXCLUDED.name),
       treatment_interest = COALESCE(EXCLUDED.treatment_interest, leads.treatment_interest),
       budget_hint = COALESCE(EXCLUDED.budget_hint, leads.budget_hint),
       country = COALESCE(EXCLUDED.country, leads.country),
       consent = leads.consent OR EXCLUDED.consent,
       source = 'widget', updated_at = now()
     RETURNING id`,
    [clinicId, d.phone, d.name || null, d.country || null, d.language || null,
     d.treatment || null, d.budget || null, d.consent === true],
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
export async function getAnalytics() {
  const trend = await pool.query(`
    SELECT d::date AS day, count(l.id) AS count
    FROM generate_series(now()::date - interval '13 days', now()::date, interval '1 day') d
    LEFT JOIN leads l ON l.created_at::date = d::date
    GROUP BY d ORDER BY d
  `);
  const funnel = await pool.query(`
    SELECT
      (SELECT count(*) FROM leads)                                  AS leads,
      (SELECT count(*) FROM leads WHERE status IN ('hot','handed_over','booked')) AS qualified,
      (SELECT count(*) FROM leads WHERE status IN ('handed_over','booked'))       AS handed_over,
      (SELECT count(*) FROM leads WHERE status = 'booked')          AS booked
  `);
  const bySource = await pool.query(`
    SELECT COALESCE(source,'unknown') AS source, count(*) AS count
    FROM leads GROUP BY source ORDER BY count DESC
  `);
  const byLang = await pool.query(`
    SELECT COALESCE(language,'?') AS language, count(*) AS count
    FROM leads GROUP BY language ORDER BY count DESC
  `);
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

  const totalLeads = Number(funnel.rows[0].leads);
  const totalSpend = Number(spend.rows[0].total_spend);
  const cac = totalLeads ? +(totalSpend / totalLeads).toFixed(2) : 0;
  // Revenue is now a real sum over payments.status = 'paid' — see migration
  // 009. It reads as zero until deposits are logged, which is the honest
  // number: no money has been recorded as collected yet.
  const paymentTotals = await getPaymentTotals();
  const revenue = paymentTotals.collected;
  const roas = totalSpend ? +(revenue / totalSpend).toFixed(2) : 0;

  return {
    trend: trend.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
    funnel: funnel.rows[0],
    by_source: bySource.rows,
    by_language: byLang.rows,
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

// ── Broadcast segments ──────────────────────────────────────────────────────
export async function getLeadsBySegment(segment) {
  const where = {
    all: '',
    past: `WHERE status IN ('handed_over','booked')`,
    hot: `WHERE status = 'hot'`,
    new: `WHERE status = 'new'`,
  }[segment] ?? '';
  const q = await pool.query(
    `SELECT id, phone, name, language FROM leads ${where} ORDER BY created_at DESC`,
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

// Route a lead to the least-loaded active coordinator who speaks its language.
// No-op if already assigned or no coordinator covers that language (AI bridges).
export async function assignCoordinatorByLanguage(leadId, langCode) {
  if (!langCode) return null;
  const existing = await pool.query('SELECT coordinator_id FROM leads WHERE id = $1', [leadId]);
  if (existing.rows[0]?.coordinator_id) return existing.rows[0].coordinator_id;

  const pick = await pool.query(
    `SELECT co.id, count(l.id) AS load
       FROM coordinators co
       LEFT JOIN leads l ON l.coordinator_id = co.id
      WHERE co.active AND $1 = ANY(co.languages)
      GROUP BY co.id
      ORDER BY load ASC
      LIMIT 1`,
    [langCode],
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

export async function getConsultantMetrics() {
  const coords = await pool.query(`
    SELECT co.id, co.name, co.languages, co.active,
      count(l.id)                                       AS assigned,
      count(l.id) FILTER (WHERE l.status='hot')         AS hot,
      count(l.id) FILTER (WHERE l.status='handed_over') AS handed_over,
      count(l.id) FILTER (WHERE l.status='booked')      AS booked
    FROM coordinators co
    LEFT JOIN leads l ON l.coordinator_id = co.id
    GROUP BY co.id
    ORDER BY assigned DESC, co.name
  `);
  // Languages present in leads that NO active coordinator can serve.
  const gaps = await pool.query(`
    SELECT DISTINCT l.language
    FROM leads l
    WHERE l.language IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM coordinators c WHERE c.active AND l.language = ANY(c.languages)
      )
  `);
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
  const q = await pool.query(`
    SELECT t.id, t.kind, t.lead_id, l.phone, l.name, l.language
    FROM post_op_tasks t JOIN leads l ON l.id = t.lead_id
    WHERE t.status='pending' AND t.due_at <= now()
    ORDER BY t.due_at LIMIT 50
  `);
  return q.rows;
}
export async function markPostOpSent(id) {
  await pool.query(`UPDATE post_op_tasks SET status='sent' WHERE id=$1`, [id]);
}

export async function getPostOpOverview() {
  const q = await pool.query(`
    SELECT l.id AS lead_id, l.name, l.phone,
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
  const q = await pool.query(`
    SELECT d.id, d.name, d.type,
      count(a.id) FILTER (WHERE a.starts_at::date = now()::date AND a.status='booked') AS today_booked
    FROM devices d
    LEFT JOIN appointments a ON a.device_id = d.id
    WHERE d.active GROUP BY d.id ORDER BY d.name
  `);
  return q.rows.map((r) => ({
    ...r,
    slots: SLOTS_PER_DAY,
    utilization: Math.round((Number(r.today_booked) / SLOTS_PER_DAY) * 100),
  }));
}

// Hot/booked leads that don't yet have an appointment — the waiting list.
export async function getWaitingList() {
  const q = await pool.query(`
    SELECT l.id, l.name, l.phone, l.treatment_interest, l.score
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
    SELECT lo.lead_id, l.name, l.phone, l.country,
      lo.flight_no, lo.arrival_at, lo.transfer_status, lo.hotel_status, lo.appointment_status
    FROM logistics lo JOIN leads l ON l.id = lo.lead_id
    ORDER BY lo.updated_at DESC
  `);
  return q.rows;
}

export async function upsertLogistics(leadId, d) {
  const clinicId = await getDefaultClinicId();
  const q = await pool.query(
    `INSERT INTO logistics (clinic_id, lead_id, flight_no, arrival_at, transfer_status, hotel_status, appointment_status, updated_at)
       VALUES ($1,$2,$3,$4,COALESCE($5,'pending'),COALESCE($6,'pending'),COALESCE($7,'pending'), now())
     ON CONFLICT (lead_id) DO UPDATE SET
       flight_no = COALESCE(EXCLUDED.flight_no, logistics.flight_no),
       arrival_at = COALESCE(EXCLUDED.arrival_at, logistics.arrival_at),
       transfer_status = COALESCE($5, logistics.transfer_status),
       hotel_status = COALESCE($6, logistics.hotel_status),
       appointment_status = COALESCE($7, logistics.appointment_status),
       updated_at = now()
     RETURNING lead_id`,
    [clinicId, leadId, d.flight_no || null, d.arrival_at || null,
     d.transfer_status || null, d.hotel_status || null, d.appointment_status || null],
  );
  return q.rows[0];
}
