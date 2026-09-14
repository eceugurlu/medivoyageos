import { pool } from '../db/pool.js';
import { getProfile } from '../services/profile.js'; // draftQuoteFromLead() için — bkz. devresel import notu

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
// Paginated — the panel used to hard-cap at 100 and silently hide older threads.
export async function listConversations({ limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const [q, countQ] = await Promise.all([
    pool.query(
      `
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
    LIMIT $1 OFFSET $2
  `,
      [safeLimit, safeOffset],
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM conversations`),
  ]);
  return {
    items: q.rows,
    total: countQ.rows[0].total,
    limit: safeLimit,
    offset: safeOffset,
  };
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
  const quotes = await listQuotesForLead(leadId);
  return { lead, conversation, messages, notes, payments, quotes };
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
    `SELECT id, amount, currency, type, status, to_char(due_date, 'YYYY-MM-DD') AS due_date, paid_at,
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
     RETURNING id, amount, currency, type, status, to_char(due_date, 'YYYY-MM-DD') AS due_date, paid_at,
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
     RETURNING id, lead_id, amount, currency, type, status, to_char(due_date, 'YYYY-MM-DD') AS due_date, paid_at,
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
           to_char(min(p.due_date), 'YYYY-MM-DD') AS earliest_due, max(p.reminder_sent_at) AS last_reminder
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

export async function getNoShowRisks() {
  const q = await pool.query(`
    SELECT l.id, l.name, l.phone, l.language, l.country, l.status, l.risk_notified_at,
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
  `);

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
        ...risk,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

// The scheduler notifies once per threshold crossing, not once per scan.
export async function markRiskNotified(leadId) {
  await pool.query('UPDATE leads SET risk_notified_at = now() WHERE id = $1', [leadId]);
}
export async function clearRiskNotified(leadId) {
  await pool.query(
    'UPDATE leads SET risk_notified_at = NULL WHERE id = $1 AND risk_notified_at IS NOT NULL',
    [leadId],
  );
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
