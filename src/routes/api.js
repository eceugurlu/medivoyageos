import crypto from 'crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { dbEnabled } from '../db/pool.js';
import { sendText, sendTemplate, sendDocument } from '../services/whatsapp.js';
import { renderQuotePdf } from '../services/pdf.js';
import { listTemplates, renderPreview, TEMPLATES } from '../templates.js';
import { getProfile, updateProfile } from '../services/profile.js';
import {
  getStats,
  listConversations,
  getHandoverQueue,
  getConversationDetail,
  setConversationStatus,
  recordAgentMessage,
  getLeadPhone,
  createWidgetLead,
  getAnalytics,
  getLeadsBySegment,
  getConsultantMetrics,
  schedulePostOp,
  getPostOpOverview,
  getReviewStats,
  getDevicesWithUtilization,
  getWaitingList,
  bookAppointment,
  getLogistics,
  upsertLogistics,
  addLeadNote,
  listPaymentsForLead,
  createPayment,
  updatePayment,
  listPendingDeposits,
  getNoShowRisks,
  listQuotesForLead,
  draftQuoteFromLead,
  createQuote,
  updateQuote,
  getQuoteById,
  getQuoteByToken,
  markQuoteSent,
  markQuoteViewed,
  markQuoteAccepted,
  listBranches,
  setLeadBranch,
  normalizeBranchId,
} from '../store/repository.js';

// ── Public router (NO auth) — for the embeddable website lead widget ─────────
export const publicRouter = Router();

// The widget is embedded on external clinic websites, so its lead endpoint must
// accept cross-origin requests (with a preflight for JSON POSTs).
publicRouter.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

publicRouter.use((req, res, next) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not configured' });
  next();
});

publicRouter.post('/lead', (req, res) => {
  (async () => {
    const b = req.body || {};
    const phone = String(b.phone || '').replace(/[^\d]/g, '');
    if (!phone) {
      return res.status(400).json({ error: 'a valid phone number is required' });
    }
    const { leadId } = await createWidgetLead({
      phone,
      name: b.name, country: b.country, language: b.language,
      treatment: b.treatment, budget: b.budget, message: b.message,
      consent: b.consent === true,
    });
    res.json({ ok: true, leadId });
  })().catch((err) => {
    console.error('[public] lead error:', err.message);
    res.status(500).json({ error: err.message });
  });
});

// ── Public quote link (NO auth, by design) ────────────────────────────────
// The patient reaches these from a WhatsApp message, not from a logged-in
// session — they can't carry a PANEL_API_TOKEN. Two separate URLs:
//   .../file   — raw PDF bytes, no side effect. This is what gets handed to
//                Meta as the document.link for delivery, so Meta's own fetch
//                of it is never mistaken for the patient opening it.
//   (bare)     — what the patient actually taps. Marks the quote viewed
//                (once — see markQuoteViewed's idempotency) and redirects to
//                .../file. One click, one honest signal.
publicRouter.get('/quote/:token/file', (req, res) => {
  (async () => {
    const quote = await getQuoteByToken(req.params.token);
    if (!quote) return res.status(404).send('Quote not found');
    const [profile, lead] = await Promise.all([getProfile(), getConversationDetail(quote.lead_id)]);
    const pdf = await renderQuotePdf({ clinic: profile, lead: lead.lead, quote });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="quote.pdf"');
    res.send(pdf);
  })().catch((err) => {
    console.error('[public] quote file error:', err.message);
    res.status(500).send('Could not generate the quote right now.');
  });
});

publicRouter.get('/quote/:token', (req, res) => {
  (async () => {
    const quote = await getQuoteByToken(req.params.token);
    if (!quote) return res.status(404).send('Quote not found');
    await markQuoteViewed(quote.id);
    res.redirect(`/api/public/quote/${req.params.token}/file`);
  })().catch((err) => {
    console.error('[public] quote view error:', err.message);
    res.status(500).send('Something went wrong.');
  });
});

export const apiRouter = Router();

// The panel needs the database. In in-memory mode there are no lead rows to show.
apiRouter.use((req, res, next) => {
  if (!dbEnabled) {
    return res.status(503).json({ error: 'Panel requires DATABASE_URL (Postgres). Set it and restart.' });
  }
  next();
});

// Optional bearer-token protection (enabled only if PANEL_API_TOKEN is set).
// Compare via SHA-256 digests so a wrong-length token cannot short-circuit
// timingSafeEqual, and so the secret itself is never used as a Buffer length oracle.
apiRouter.use((req, res, next) => {
  if (!config.panel.apiToken) return next();
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(config.panel.apiToken).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

// Small async wrapper so a thrown error becomes a clean 500 instead of a crash.
const h = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error('[api] error:', err.message);
    res.status(500).json({ error: err.message });
  });

apiRouter.get('/stats', h(async (req, res) => {
  res.json(await getStats({ branchId: normalizeBranchId(req.query.branch_id) }));
}));

apiRouter.get('/branches', h(async (_req, res) => {
  res.json(await listBranches());
}));

apiRouter.get('/conversations', h(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  res.json(await listConversations({
    limit,
    offset,
    branchId: normalizeBranchId(req.query.branch_id),
  }));
}));

apiRouter.get('/handovers', h(async (req, res) => {
  res.json(await getHandoverQueue({ branchId: normalizeBranchId(req.query.branch_id) }));
}));

apiRouter.put('/conversations/:leadId/branch', h(async (req, res) => {
  try {
    res.json(await setLeadBranch(req.params.leadId, req.body?.branch_id ?? null));
  } catch (err) {
    const status = err.message === 'lead not found' || err.message === 'branch not found' ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
}));

apiRouter.get('/conversations/:leadId', h(async (req, res) => {
  const detail = await getConversationDetail(req.params.leadId);
  if (!detail) return res.status(404).json({ error: 'Lead not found' });
  res.json(detail);
}));

// Add an internal note to a lead. Notes come back with the conversation
// detail, so there is no matching GET here.
apiRouter.post('/conversations/:leadId/notes', h(async (req, res) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note text is required' });
  const note = await addLeadNote(req.params.leadId, body.slice(0, 2000), req.body?.author || null);
  res.json(note);
}));

// ── Payments ─────────────────────────────────────────────────────────────
// List and create are lead-scoped, matching the /conversations/:leadId/...
// pattern the rest of the panel already uses. Status changes (mark paid,
// mark reminder sent) go through /payments/:id since they don't need the
// lead id once you have the payment's own id.
apiRouter.get('/conversations/:leadId/payments', h(async (req, res) => {
  res.json(await listPaymentsForLead(req.params.leadId));
}));

apiRouter.post('/conversations/:leadId/payments', h(async (req, res) => {
  const { amount, currency, type, dueDate, note } = req.body || {};
  try {
    const payment = await createPayment(req.params.leadId, { amount, currency, type, dueDate, note });
    res.json(payment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

apiRouter.put('/payments/:paymentId', h(async (req, res) => {
  const { status, reminder } = req.body || {};
  try {
    const payment = await updatePayment(req.params.paymentId, { status, reminder });
    res.json(payment);
  } catch (err) {
    res.status(err.message === 'payment not found' ? 404 : 400).json({ error: err.message });
  }
}));

// Cross-lead list for the Inbox's "Awaiting deposit" filter.
apiRouter.get('/payments/pending', h(async (req, res) => {
  res.json(await listPendingDeposits({ branchId: normalizeBranchId(req.query.branch_id) }));
}));

// Rule-based no-show risk, recomputed per request — it is derived entirely
// from data that already exists (silence, deposits, dates, wording), so there
// is nothing to store and nothing to go stale.
apiRouter.get('/risk', h(async (req, res) => {
  res.json(await getNoShowRisks({ branchId: normalizeBranchId(req.query.branch_id) }));
}));

// ── Quotes (Treatment Plan Builder) ───────────────────────────────────────
apiRouter.get('/conversations/:leadId/quotes', h(async (req, res) => {
  res.json(await listQuotesForLead(req.params.leadId));
}));

// Pre-fills a draft from what the concierge already knows about the lead
// (treatment + the clinic's own price list) — never an invented number, see
// draftQuoteFromLead()'s comment. The coordinator always edits before sending.
apiRouter.post('/conversations/:leadId/quotes/draft', h(async (req, res) => {
  try {
    res.json(await draftQuoteFromLead(req.params.leadId));
  } catch (err) {
    res.status(err.message === 'lead not found' ? 404 : 400).json({ error: err.message });
  }
}));

// Manual quote, written by a coordinator from scratch instead of the draft
// suggestion — same shape, just skips the auto-fill step.
apiRouter.post('/conversations/:leadId/quotes', h(async (req, res) => {
  const { items, currency, language, validUntil } = req.body || {};
  try {
    res.json(await createQuote(req.params.leadId, { items, currency, language, validUntil }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

apiRouter.put('/quotes/:quoteId', h(async (req, res) => {
  const { items, currency, language, validUntil } = req.body || {};
  try {
    res.json(await updateQuote(req.params.quoteId, { items, currency, language, validUntil }));
  } catch (err) {
    res.status(err.message === 'quote not found' ? 404 : 400).json({ error: err.message });
  }
}));

// Authenticated preview — lets a coordinator see exactly what the patient
// will get before sending it. Same renderer the send route and the public
// tracking link use, so there's no risk of the preview looking different.
apiRouter.get('/quotes/:quoteId/pdf', h(async (req, res) => {
  const quote = await getQuoteById(req.params.quoteId);
  if (!quote) return res.status(404).json({ error: 'quote not found' });
  const [profile, lead] = await Promise.all([getProfile(), getConversationDetail(quote.lead_id)]);
  const pdf = await renderQuotePdf({ clinic: profile, lead: lead.lead, quote });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'inline; filename="quote.pdf"');
  res.send(pdf);
}));

// Short, per-language line sent alongside the PDF. Deliberately not the full
// LABELS set from pdf.js — this is one WhatsApp caption sentence, not a
// document, so a small map here is proportionate.
const SEND_CAPTIONS = {
  en: (url) => `Here's your treatment quote 📄 View it online any time: ${url}`,
  tr: (url) => `Tedavi teklifiniz ekte 📄 İstediğiniz an çevrimiçi görüntüleyin: ${url}`,
  de: (url) => `Hier ist Ihr Behandlungsangebot 📄 Jederzeit online ansehen: ${url}`,
  ar: (url) => `إليك عرض سعر علاجك 📄 يمكنك الاطلاع عليه عبر الإنترنت في أي وقت: ${url}`,
  ru: (url) => `Вот ваша смета лечения 📄 Смотрите онлайн в любое время: ${url}`,
  fr: (url) => `Voici votre devis de traitement 📄 Consultez-le en ligne à tout moment : ${url}`,
};

// Sends the quote: WhatsApp gets a document (Meta's servers fetch the PDF
// once, by link, to attach it) plus a caption carrying the SEPARATE tracking
// link. Those are two different URLs on purpose — see services/pdf.js's
// sibling routes below in publicRouter — so Meta's own fetch of the file
// never gets counted as the patient having viewed it.
apiRouter.post('/quotes/:quoteId/send', h(async (req, res) => {
  const quote = await getQuoteById(req.params.quoteId);
  if (!quote) return res.status(404).json({ error: 'quote not found' });
  if (quote.status !== 'draft') return res.status(400).json({ error: 'quote already sent' });

  const phone = await getLeadPhone(quote.lead_id);
  if (!phone) return res.status(400).json({ error: 'lead has no phone number' });

  const fileUrl = `${config.publicBaseUrl}/api/public/quote/${quote.view_token}/file`;
  const trackUrl = `${config.publicBaseUrl}/api/public/quote/${quote.view_token}`;
  const caption = (SEND_CAPTIONS[quote.language] || SEND_CAPTIONS.en)(trackUrl);

  try {
    await sendDocument(phone, fileUrl, 'quote.pdf', caption);
  } catch (err) {
    return res.status(502).json({ error: `WhatsApp send failed: ${err.message}` });
  }
  res.json(await markQuoteSent(quote.id));
}));

// Coordinator marks a quote accepted — after a phone call, an in-person
// confirmation, or a WhatsApp reply the AI doesn't yet parse as acceptance.
// A manual switch is honest here: there is no online "accept" flow yet.
apiRouter.post('/quotes/:quoteId/accept', h(async (req, res) => {
  try {
    res.json(await markQuoteAccepted(req.params.quoteId));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
}));

// Agent takes over — pause the AI for this conversation.
apiRouter.post('/conversations/:leadId/takeover', h(async (req, res) => {
  const updated = await setConversationStatus(req.params.leadId, 'human_handling');
  if (!updated) return res.status(404).json({ error: 'Conversation not found' });
  res.json(updated);
}));

// Hand back to the AI.
apiRouter.post('/conversations/:leadId/handback', h(async (req, res) => {
  const updated = await setConversationStatus(req.params.leadId, 'ai_handling');
  if (!updated) return res.status(404).json({ error: 'Conversation not found' });
  res.json(updated);
}));

// Agent sends a manual reply from the panel.
apiRouter.post('/conversations/:leadId/reply', h(async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty message' });

  const phone = await getLeadPhone(req.params.leadId);
  if (!phone) return res.status(404).json({ error: 'Lead not found' });

  await recordAgentMessage(req.params.leadId, text);
  // Keep the conversation human-handled once an agent has replied.
  await setConversationStatus(req.params.leadId, 'human_handling');

  let delivered = true;
  try {
    await sendText(phone, text);
  } catch (err) {
    delivered = false;
    console.error('[api] reply send failed:', err.message);
  }
  res.json({ ok: true, delivered });
}));

// Analytics: CAC / ROAS / funnel / 14-day trend / sources / by_branch.
apiRouter.get('/analytics', h(async (req, res) => {
  res.json(await getAnalytics({ branchId: normalizeBranchId(req.query.branch_id) }));
}));

// Consultant performance + language coordinator matching.
apiRouter.get('/consultants', h(async (req, res) => {
  res.json(await getConsultantMetrics({ branchId: normalizeBranchId(req.query.branch_id) }));
}));

// ── Post-Op & Trust/Review (Modül 8+9) ──────────────────────────────────────
// Mark a patient discharged → schedule the full post-op sequence + logistics row.
apiRouter.post('/conversations/:leadId/discharge', h(async (req, res) => {
  const n = await schedulePostOp(req.params.leadId);
  await upsertLogistics(req.params.leadId, {});
  res.json({ ok: true, tasks_scheduled: n });
}));
apiRouter.get('/postop', h(async (_req, res) => res.json(await getPostOpOverview())));
apiRouter.get('/reviews', h(async (_req, res) => res.json(await getReviewStats())));

// ── Smart Device Booking (Modül 3) ──────────────────────────────────────────
apiRouter.get('/devices', h(async (_req, res) => {
  res.json({ devices: await getDevicesWithUtilization(), waiting: await getWaitingList() });
}));
apiRouter.post('/appointments', h(async (req, res) => {
  const { deviceId, leadId, startsAt, endsAt } = req.body || {};
  if (!deviceId || !leadId) return res.status(400).json({ error: 'deviceId and leadId required' });
  const start = startsAt || new Date(Date.now() + 86400000).toISOString();
  const end = endsAt || new Date(Date.now() + 86400000 + 3600000).toISOString();
  res.json(await bookAppointment(deviceId, leadId, start, end));
}));

// ── VIP Transfer & Logistics (Modül 6) ──────────────────────────────────────
apiRouter.get('/logistics', h(async (_req, res) => res.json(await getLogistics())));
apiRouter.put('/logistics/:leadId', h(async (req, res) => res.json(await upsertLogistics(req.params.leadId, req.body || {}))));

// Available WhatsApp templates (for the Campaigns composer).
apiRouter.get('/templates', h(async (_req, res) => {
  res.json(listTemplates());
}));

// AI Prompt Studio — read / update the live clinic profile (AI knowledge base).
apiRouter.get('/settings', h(async (_req, res) => {
  res.json(await getProfile());
}));

apiRouter.put('/settings', h(async (req, res) => {
  const patch = req.body || {};
  // Only accept known top-level fields; ignore anything unexpected.
  const allowed = ['name','city','tone','languages','treatments','availabilityNote','bookingPolicy','contact'];
  const clean = {};
  for (const k of allowed) if (k in patch) clean[k] = patch[k];
  const updated = await updateProfile(clean);
  res.json(updated);
}));

// Broadcast an approved template to a segment of leads.
// body: { template: 'reengagement', segment: 'past'|'all'|'hot'|'new', variables?: {offer?, date?} }
apiRouter.post('/campaigns/broadcast', h(async (req, res) => {
  const { template, segment = 'past', variables = {} } = req.body || {};
  const tpl = TEMPLATES[template];
  if (!tpl) return res.status(400).json({ error: 'Unknown template' });

  const leads = await getLeadsBySegment(segment);
  let sent = 0;
  const results = [];
  for (const lead of leads) {
    // Fill template params in order. 'name' comes from the lead; the rest from
    // the request (e.g. offer text, appointment date).
    const vars = tpl.params.map((p) => (p === 'name' ? lead.name || 'there' : variables[p] || ''));
    try {
      await sendTemplate(lead.phone, tpl.name, tpl.language, vars);
      await recordAgentMessage(lead.id, `📢 [template:${tpl.name}] ${renderPreview(template, vars)}`);
      sent += 1;
      results.push({ phone: lead.phone, ok: true });
    } catch (err) {
      results.push({ phone: lead.phone, ok: false, error: err.message });
    }
  }
  console.log(`[broadcast] template "${tpl.name}" → segment "${segment}": ${sent}/${leads.length} sent`);
  res.json({ ok: true, template: tpl.name, segment, recipients: leads.length, sent, results });
}));
