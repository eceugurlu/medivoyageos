import { Router } from 'express';
import { config } from '../config.js';
import { dbEnabled } from '../db/pool.js';
import { sendText, sendTemplate } from '../services/whatsapp.js';
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

export const apiRouter = Router();

// The panel needs the database. In in-memory mode there are no lead rows to show.
apiRouter.use((req, res, next) => {
  if (!dbEnabled) {
    return res.status(503).json({ error: 'Panel requires DATABASE_URL (Postgres). Set it and restart.' });
  }
  next();
});

// Optional bearer-token protection (enabled only if PANEL_API_TOKEN is set).
apiRouter.use((req, res, next) => {
  if (!config.panel.apiToken) return next();
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${config.panel.apiToken}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

// Small async wrapper so a thrown error becomes a clean 500 instead of a crash.
const h = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error('[api] error:', err.message);
    res.status(500).json({ error: err.message });
  });

apiRouter.get('/stats', h(async (_req, res) => {
  res.json(await getStats());
}));

apiRouter.get('/conversations', h(async (_req, res) => {
  res.json(await listConversations());
}));

apiRouter.get('/handovers', h(async (_req, res) => {
  res.json(await getHandoverQueue());
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
apiRouter.get('/payments/pending', h(async (_req, res) => {
  res.json(await listPendingDeposits());
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

// Analytics: CAC / ROAS / funnel / 14-day trend / sources.
apiRouter.get('/analytics', h(async (_req, res) => {
  res.json(await getAnalytics());
}));

// Consultant performance + language coordinator matching.
apiRouter.get('/consultants', h(async (_req, res) => {
  res.json(await getConsultantMetrics());
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
