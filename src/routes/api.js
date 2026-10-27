import crypto from 'crypto';
import { Router } from 'express';
import { config, isProduction } from '../config.js';
import { dbEnabled } from '../db/pool.js';
import { sendText, sendTemplate, sendDocument } from '../services/whatsapp.js';
import { renderQuotePdf } from '../services/pdf.js';
import { listTemplates, renderPreview, TEMPLATES } from '../templates.js';
import { getProfile, updateProfile } from '../services/profile.js';
import { createCheckoutSession } from '../services/stripe.js';
import { createCheckoutForm } from '../services/iyzico.js';
import { sendToLead } from '../services/channelSend.js';
import { getAutomationStatus } from '../services/automationStatus.js';
import { guardUuidParams } from '../middleware/validateUuidParams.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  attachLeadAttribution,
  getCampaignPerformance,
  getStats,
  listConversations,
  getHandoverQueue,
  getConversationDetail,
  setConversationStatus,
  recordAgentMessage,
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
  getLogisticsByToken,
  addLeadNote,
  listPaymentsForLead,
  createPayment,
  getPaymentById,
  setPaymentCheckout,
  markPaymentLinkSent,
  updatePayment,
  listPendingDeposits,
  getLeadChannel,
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
  listAllBranches,
  createBranch,
  updateBranch,
  listAllCoordinators,
  createCoordinator,
  updateCoordinator,
  listAllDevices,
  createDevice,
  updateDevice,
  deleteDevice,
  deleteBranch,
  deleteCoordinator,
  deletePartner,
  deleteDoctor,
  deleteLead,
  updatePartner,
  updateDoctor,
  updateLead,
  listAppointments,
  cancelAppointment,
  deleteAppointment,
  deleteQuote,
  deleteLeadNote,
  deletePayment,
  setLeadBranch,
  normalizeBranchId,
  normalizeUuid,
  listPartners,
  createPartner,
  setLeadPartner,
  regeneratePartnerToken,
  getMessageMedia,
  getRoiStats,
  listDoctors,
  createDoctor,
  setLeadDoctor,
  regenerateDoctorToken,
  listCostsForLead,
  createCost,
  deleteCost,
  getProfitability,
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

// This is the one fully public, cross-origin write in the app, so field sizes
// are clamped here at the boundary rather than trusted: the columns behind it
// are unbounded TEXT, and without a cap a single scripted caller could store
// ~100KB (express.json's body limit) per field per submission and push that
// straight into the coordinator's inbox.
const clamp = (v, max) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : undefined;
};

publicRouter.post('/lead', rateLimit(), (req, res) => {
  (async () => {
    const b = req.body || {};
    // A real E.164 number is at most 15 digits; the slack absorbs a stray
    // country prefix or separator without accepting a pasted essay.
    const phone = String(b.phone || '').replace(/[^\d]/g, '').slice(0, 20);
    if (!phone) {
      return res.status(400).json({ error: 'a valid phone number is required' });
    }
    const { leadId } = await createWidgetLead({
      phone,
      name: clamp(b.name, 120), country: clamp(b.country, 80), language: clamp(b.language, 40),
      treatment: clamp(b.treatment, 120), budget: clamp(b.budget, 80), message: clamp(b.message, 2000),
      consent: b.consent === true,
      // A partner's PUBLIC referral code, never their private portal token —
      // see migration 022 / createPartner().
      referralCode: clamp(b.referralCode, 64),
    });

    // Reklam → Hasta Atfetme. Clamped like every other field on this public
    // boundary, and recorded AFTER the lead exists so a malformed attribution
    // payload can never cost the clinic the lead itself. First touch wins, so
    // a returning visitor's second ad click does not overwrite the first.
    const a = b.attribution;
    if (a && typeof a === 'object') {
      await attachLeadAttribution(leadId, {
        sourceId: clamp(a.sourceId, 190),
        sourceType: clamp(a.sourceType, 40) || 'utm',
        sourceUrl: clamp(a.sourceUrl, 500),
        headline: clamp(a.headline, 190),
        ctwaClid: clamp(a.clickId, 190),
      }).catch((err) => console.error('[public] attribution failed (non-fatal):', err.message));
    }
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

// Patient-facing itinerary — same unauthenticated-by-token pattern as the
// quote link above. JSON, not HTML: public/itinerary.html renders it, same
// division of labor as the widget.
publicRouter.get('/itinerary/:token', (req, res) => {
  (async () => {
    const it = await getLogisticsByToken(req.params.token);
    if (!it) return res.status(404).json({ error: 'Not found' });
    res.json(it);
  })().catch((err) => {
    console.error('[public] itinerary error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
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
  if (!config.panel.apiToken) {
    // Leaving the panel open is a localhost convenience. On a public
    // deployment it would expose every conversation, photo and medical note
    // in the clinic to anyone who finds the URL, so an unset token is refused
    // there rather than treated as "protection disabled".
    if (isProduction) {
      console.error(
        '[api] REJECTED: PANEL_API_TOKEN is not set on this production deployment, which would ' +
          'leave all patient data publicly readable. Set PANEL_API_TOKEN to open the panel.',
      );
      return res.status(503).json({ error: 'Panel authentication is not configured on this deployment.' });
    }
    return next();
  }
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(config.panel.apiToken).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

// Reject a malformed :id with 400 before it ever reaches a query — see
// middleware/validateUuidParams.js for why this is central and not per-route.
guardUuidParams(apiRouter);

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

// Branch management. The listing above is the active-only one the branch
// filter uses; this returns deactivated rows too so they can be switched back.
apiRouter.get('/branches/all', h(async (_req, res) => {
  res.json(await listAllBranches());
}));
apiRouter.post('/branches', h(async (req, res) => {
  const { name, code, city } = req.body || {};
  res.json(await createBranch({ name, code, city }));
}));
apiRouter.patch('/branches/:branchId', h(async (req, res) => {
  const { name, code, city, active } = req.body || {};
  res.json(await updateBranch(req.params.branchId, { name, code, city, active }));
}));
apiRouter.delete('/branches/:branchId', h(async (req, res) => {
  res.json(await deleteBranch(req.params.branchId));
}));

// ── Partners (referral agents) ──────────────────────────────────────────────
// Management is panel-side (PANEL_API_TOKEN, same as everything else in this
// router); the partner's own read-only dashboard lives at /api/partner/*
// (src/routes/partner.js), authenticated with their own token instead.
apiRouter.get('/partners', h(async (_req, res) => {
  res.json(await listPartners());
}));

apiRouter.post('/partners', h(async (req, res) => {
  const { name, email, commissionRate } = req.body || {};
  try {
    res.json(await createPartner({ name, email, commissionRate }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

apiRouter.put('/conversations/:leadId/partner', h(async (req, res) => {
  try {
    res.json(await setLeadPartner(req.params.leadId, req.body?.partner_id ?? null));
  } catch (err) {
    const status = err.message === 'lead not found' || err.message === 'partner not found' ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
}));

// Lost-token recovery — a partner's token is shown once at creation and
// never stored anywhere retrievable, same as any API key. This invalidates
// the old one and issues a fresh one (shown once again, in the panel).
apiRouter.post('/partners/:partnerId/regenerate', h(async (req, res) => {
  try {
    res.json(await regeneratePartnerToken(req.params.partnerId));
  } catch (err) {
    res.status(err.message === 'partner not found' ? 404 : 400).json({ error: err.message });
  }
}));
apiRouter.delete('/partners/:partnerId', h(async (req, res) => {
  res.json(await deletePartner(req.params.partnerId));
}));
apiRouter.patch('/partners/:partnerId', h(async (req, res) => {
  const { name, email, commissionRate, active } = req.body || {};
  res.json(await updatePartner(req.params.partnerId, { name, email, commissionRate, active }));
}));

// ── Doctors (Doctor Portal) ─────────────────────────────────────────────────
// Management is panel-side; the doctor's own review view lives at
// /api/doctor/* (src/routes/doctor.js), authenticated with their own token.
apiRouter.get('/doctors', h(async (_req, res) => {
  res.json(await listDoctors());
}));

apiRouter.post('/doctors', h(async (req, res) => {
  const { name, email, specialty } = req.body || {};
  try {
    res.json(await createDoctor({ name, email, specialty }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

apiRouter.put('/conversations/:leadId/doctor', h(async (req, res) => {
  try {
    res.json(await setLeadDoctor(req.params.leadId, req.body?.doctor_id ?? null));
  } catch (err) {
    const status = err.message === 'lead not found' || err.message === 'doctor not found' ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
}));

// Lost-token recovery — same reasoning as the partner one above.
apiRouter.post('/doctors/:doctorId/regenerate', h(async (req, res) => {
  try {
    res.json(await regenerateDoctorToken(req.params.doctorId));
  } catch (err) {
    res.status(err.message === 'doctor not found' ? 404 : 400).json({ error: err.message });
  }
}));
apiRouter.delete('/doctors/:doctorId', h(async (req, res) => {
  res.json(await deleteDoctor(req.params.doctorId));
}));
apiRouter.patch('/doctors/:doctorId', h(async (req, res) => {
  const { name, email, specialty, active } = req.body || {};
  res.json(await updateDoctor(req.params.doctorId, { name, email, specialty, active }));
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

// Photo a patient sent, for the panel's own authenticated viewer.
apiRouter.get('/messages/:messageId/media', h(async (req, res) => {
  const media = await getMessageMedia(req.params.messageId);
  if (!media) return res.status(404).json({ error: 'no media on this message' });
  res.set('Content-Type', media.media_mime_type);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(media.media_data);
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
apiRouter.delete('/notes/:noteId', h(async (req, res) => {
  res.json(await deleteLeadNote(req.params.noteId));
}));
apiRouter.patch('/conversations/:leadId', h(async (req, res) => {
  const { name, country, language, treatmentInterest, budgetHint, status } = req.body || {};
  res.json(await updateLead(req.params.leadId, { name, country, language, treatmentInterest, budgetHint, status }));
}));
apiRouter.delete('/payments/:paymentId', h(async (req, res) => {
  res.json(await deletePayment(req.params.paymentId));
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

const PAYMENT_LINK_CAPTIONS = {
  en: (amount, currency, url) => `To secure your booking, please complete your ${currency} ${amount} payment here — it's a secure checkout page: ${url}`,
  tr: (amount, currency, url) => `Randevunuzu kesinleştirmek için lütfen ${currency} ${amount} tutarındaki ödemenizi buradan tamamlayın — güvenli bir ödeme sayfasıdır: ${url}`,
  de: (amount, currency, url) => `Um Ihren Termin zu sichern, schließen Sie bitte Ihre Zahlung über ${currency} ${amount} hier ab — eine sichere Zahlungsseite: ${url}`,
  ar: (amount, currency, url) => `لتأكيد حجزك، يرجى إكمال دفعتك البالغة ${currency} ${amount} هنا — صفحة دفع آمنة: ${url}`,
  ru: (amount, currency, url) => `Чтобы подтвердить запись, пожалуйста, завершите оплату ${currency} ${amount} здесь — это безопасная страница оплаты: ${url}`,
  fr: (amount, currency, url) => `Pour confirmer votre rendez-vous, veuillez finaliser votre paiement de ${currency} ${amount} ici — une page de paiement sécurisée : ${url}`,
};
const PAYMENT_LINK_DRYRUN_NOTE = ' (demo mode — no gateway is connected yet, no real charge will occur)';

// Which gateway handles a given currency by default: a Turkish clinic entity
// often can't even open a Stripe account directly (Stripe doesn't operate
// merchant accounts in Turkey), so TRY goes to İyzico; everything else to
// Stripe, which is the one built for international cards. Both dry-run
// identically without real keys, so this picks correctly even before either
// is actually connected.
function defaultProviderFor(currency) {
  return currency === 'TRY' ? 'iyzico' : 'stripe';
}

// One click, matching how a coordinator actually wants to work: enter an
// amount, and the patient gets a real hosted payment page — Stripe or
// İyzico depending on the currency — on whatever channel they messaged in
// (WhatsApp/Instagram/Messenger), not an IBAN in a chat bubble. Creates the
// payment row AND the checkout link AND sends it, as a single request; the
// plain "add payment" endpoint above stays for logging a payment that was
// already taken some other way (e.g. bank transfer).
apiRouter.post('/conversations/:leadId/payments/link', h(async (req, res) => {
  const { amount, currency, type, dueDate, note } = req.body || {};

  const lead = await getLeadChannel(req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });

  let payment;
  try {
    payment = await createPayment(req.params.leadId, { amount, currency, type, dueDate, note });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const provider = defaultProviderFor(payment.currency);
  const profile = await getProfile();
  const description = `${profile?.name || 'Clinic'} — ${payment.type}`;
  const langParam = encodeURIComponent(lead.language || 'en');

  let session;
  try {
    if (provider === 'iyzico') {
      const form = await createCheckoutForm({
        paymentId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        description,
        buyerName: lead.name,
        buyerPhone: lead.phone,
        buyerCountry: lead.country,
        language: lead.language,
        callbackUrl: `${config.publicBaseUrl}/webhooks/iyzico/callback?lang=${langParam}`,
      });
      session = { id: form.token, url: form.url, dryRun: form.dryRun };
    } else {
      session = await createCheckoutSession({
        amount: payment.amount,
        currency: payment.currency,
        description,
        clientReferenceId: payment.id,
        language: lead.language,
        successUrl: `${config.publicBaseUrl}/panel/payment-result.html?status=success&lang=${langParam}`,
        cancelUrl: `${config.publicBaseUrl}/panel/payment-result.html?status=cancel&lang=${langParam}`,
      });
    }
  } catch (err) {
    return res.status(502).json({ error: `${provider} error: ${err.message}`, payment });
  }
  await setPaymentCheckout(payment.id, {
    provider,
    checkoutUrl: session.url,
    providerSessionId: session.id,
  });

  const captionFn = PAYMENT_LINK_CAPTIONS[lead.language] || PAYMENT_LINK_CAPTIONS.en;
  const linkForMessage = session.url || `${config.publicBaseUrl}/panel/payment-result.html?status=demo`;
  let caption = captionFn(payment.amount, payment.currency, linkForMessage);
  if (session.dryRun) caption += PAYMENT_LINK_DRYRUN_NOTE;

  try {
    await sendToLead(lead, caption);
    await markPaymentLinkSent(payment.id);
  } catch (err) {
    // The payment + link both exist even though delivery failed — surface
    // that clearly rather than losing the record the coordinator just made.
    return res.status(502).json({ error: `Link created but send failed: ${err.message}`, payment: await getPaymentById(payment.id) });
  }

  res.json(await getPaymentById(payment.id));
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

// ── Operation costs (multi-currency — hospital/driver/hotel per case) ──────
apiRouter.get('/conversations/:leadId/costs', h(async (req, res) => {
  res.json(await listCostsForLead(req.params.leadId));
}));

apiRouter.post('/conversations/:leadId/costs', h(async (req, res) => {
  const { category, amount, currency, note } = req.body || {};
  try {
    res.json(await createCost(req.params.leadId, { category, amount, currency, note }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

apiRouter.delete('/costs/:costId', h(async (req, res) => {
  try {
    res.json(await deleteCost(req.params.costId));
  } catch (err) {
    res.status(err.message === 'cost not found' ? 404 : 400).json({ error: err.message });
  }
}));

// Net profitability (revenue collected − costs logged, both normalized to EUR).
apiRouter.get('/profitability', h(async (req, res) => {
  res.json(await getProfitability({ branchId: normalizeBranchId(req.query.branch_id) }));
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
  en: (url) => `Here's your treatment quote. View it online any time: ${url}`,
  tr: (url) => `Tedavi teklifiniz ekte. İstediğiniz an çevrimiçi görüntüleyin: ${url}`,
  de: (url) => `Hier ist Ihr Behandlungsangebot. Jederzeit online ansehen: ${url}`,
  ar: (url) => `إليك عرض سعر علاجك. يمكنك الاطلاع عليه عبر الإنترنت في أي وقت: ${url}`,
  ru: (url) => `Вот ваша смета лечения. Смотрите онлайн в любое время: ${url}`,
  fr: (url) => `Voici votre devis de traitement. Consultez-le en ligne à tout moment : ${url}`,
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

  const lead = await getLeadChannel(quote.lead_id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });

  const fileUrl = `${config.publicBaseUrl}/api/public/quote/${quote.view_token}/file`;
  const trackUrl = `${config.publicBaseUrl}/api/public/quote/${quote.view_token}`;
  const caption = (SEND_CAPTIONS[quote.language] || SEND_CAPTIONS.en)(trackUrl);

  try {
    if (lead.source === 'instagram' || lead.source === 'messenger') {
      // No inline-PDF-attachment path built for Instagram/Messenger yet —
      // trackUrl already redirects straight to the PDF, so a plain text
      // message gets the patient to the same document WhatsApp attaches
      // inline; the caption already carries that link either way.
      await sendToLead(lead, caption);
    } else {
      if (!lead.phone) return res.status(400).json({ error: 'lead has no phone number' });
      await sendDocument(lead.phone, fileUrl, 'quote.pdf', caption);
    }
  } catch (err) {
    return res.status(502).json({ error: `Send failed: ${err.message}` });
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
apiRouter.delete('/quotes/:quoteId', h(async (req, res) => {
  res.json(await deleteQuote(req.params.quoteId));
}));

// Agent takes over — pause the AI for this conversation.
apiRouter.post('/conversations/:leadId/takeover', h(async (req, res) => {
  const updated = await setConversationStatus(req.params.leadId, 'human_handling');
  if (!updated) return res.status(404).json({ error: 'Conversation not found' });
  res.json(updated);
}));

// Permanently delete a patient and their whole history. Irreversible, and the
// only route in the panel that destroys medical data, so it does not act on
// the URL alone: the caller must echo the same id in the body. That makes a
// mis-fired request (a stale click, a retried fetch, a copy-pasted curl aimed
// at the wrong id) fail closed instead of erasing the wrong patient.
apiRouter.delete('/conversations/:leadId', h(async (req, res) => {
  const { confirmLeadId } = req.body || {};
  if (confirmLeadId !== req.params.leadId) {
    return res.status(400).json({ error: 'confirmLeadId must match the lead being deleted' });
  }
  res.json(await deleteLead(req.params.leadId));
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

  const lead = await getLeadChannel(req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  await recordAgentMessage(req.params.leadId, text);
  // Keep the conversation human-handled once an agent has replied.
  await setConversationStatus(req.params.leadId, 'human_handling');

  let delivered = true;
  try {
    await sendToLead(lead, text);
  } catch (err) {
    delivered = false;
    console.error('[api] reply send failed:', err.message);
  }
  res.json({ ok: true, delivered });
}));

// Analytics: CAC / ROAS / funnel / 14-day trend / sources / by_branch.
// Kampanya bazlı CAC/ROAS — the figure /analytics has always had to refuse
// to show (its own note says spend is real but CAC/ROAS are not derivable
// per channel). It is a separate endpoint rather than more fields on
// /analytics because it does per-row FX conversion and a clinic with no
// registered campaigns should not pay that cost on every dashboard load.
apiRouter.get('/campaigns/performance', h(async (req, res) => {
  res.json(await getCampaignPerformance({ branchId: normalizeBranchId(req.query.branch_id) }));
}));

apiRouter.get('/analytics', h(async (req, res) => {
  res.json(await getAnalytics({ branchId: normalizeBranchId(req.query.branch_id) }));
}));

// ROI Widget: staff hours the AI absorbed, how much of that was off-hours,
// and revenue collected — the PoC-to-paid closing argument (Command Center).
apiRouter.get('/roi', h(async (req, res) => {
  res.json(await getRoiStats({ branchId: normalizeBranchId(req.query.branch_id) }));
}));

// Consultant performance + language coordinator matching.
apiRouter.get('/consultants', h(async (req, res) => {
  res.json(await getConsultantMetrics({ branchId: normalizeBranchId(req.query.branch_id) }));
}));

// Consultant (coordinator) management — the staff the language matcher routes
// leads to. The metrics listing above only covers coordinators with activity,
// so management reads its own full list.
apiRouter.get('/consultants/all', h(async (_req, res) => {
  res.json(await listAllCoordinators());
}));
apiRouter.post('/consultants', h(async (req, res) => {
  const { name, languages, branchId } = req.body || {};
  res.json(await createCoordinator({ name, languages, branchId }));
}));
apiRouter.patch('/consultants/:coordinatorId', h(async (req, res) => {
  const { name, languages, branchId, active } = req.body || {};
  res.json(await updateCoordinator(req.params.coordinatorId, { name, languages, branchId, active }));
}));
apiRouter.delete('/consultants/:coordinatorId', h(async (req, res) => {
  res.json(await deleteCoordinator(req.params.coordinatorId));
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

// Device management. Like branches, the utilization listing above is for the
// booking grid; this one includes deactivated rows so they can be restored.
apiRouter.get('/devices/all', h(async (_req, res) => {
  res.json(await listAllDevices());
}));
apiRouter.post('/devices', h(async (req, res) => {
  const { name, type } = req.body || {};
  res.json(await createDevice({ name, type }));
}));
apiRouter.patch('/devices/:deviceId', h(async (req, res) => {
  const { name, type, active } = req.body || {};
  res.json(await updateDevice(req.params.deviceId, { name, type, active }));
}));
apiRouter.delete('/devices/:deviceId', h(async (req, res) => {
  res.json(await deleteDevice(req.params.deviceId));
}));
apiRouter.post('/appointments', h(async (req, res) => {
  const { deviceId, leadId, startsAt, endsAt } = req.body || {};
  if (!deviceId || !leadId) return res.status(400).json({ error: 'deviceId and leadId required' });
  const start = startsAt || new Date(Date.now() + 86400000).toISOString();
  const end = endsAt || new Date(Date.now() + 86400000 + 3600000).toISOString();
  res.json(await bookAppointment(deviceId, leadId, start, end));
}));

// Seeing and undoing a booking, not just making one.
apiRouter.get('/appointments', h(async (req, res) => {
  res.json(await listAppointments({
    deviceId: normalizeUuid(req.query.device_id),
    includePast: req.query.include_past === '1',
  }));
}));
apiRouter.post('/appointments/:appointmentId/cancel', h(async (req, res) => {
  res.json(await cancelAppointment(req.params.appointmentId));
}));
apiRouter.delete('/appointments/:appointmentId', h(async (req, res) => {
  res.json(await deleteAppointment(req.params.appointmentId));
}));

// ── VIP Transfer & Logistics (Modül 6) ──────────────────────────────────────
apiRouter.get('/logistics', h(async (_req, res) => res.json(await getLogistics())));
apiRouter.put('/logistics/:leadId', h(async (req, res) => {
  try {
    res.json(await upsertLogistics(req.params.leadId, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

const ITINERARY_CAPTIONS = {
  en: (url) => `Here's your live schedule — pickup time, hotel and your next appointment: ${url}`,
  tr: (url) => `Canlı programınız burada — alınış saatiniz, otel ve bir sonraki randevunuz: ${url}`,
  de: (url) => `Hier ist Ihr aktueller Zeitplan — Abholzeit, Hotel und nächster Termin: ${url}`,
  ar: (url) => `إليك جدولك المباشر — موعد الاستلام والفندق وموعدك القادم: ${url}`,
  ru: (url) => `Вот ваш актуальный график — время встречи, отель и следующая запись: ${url}`,
  fr: (url) => `Voici votre programme en direct — heure de prise en charge, hôtel et prochain rendez-vous : ${url}`,
};

// Sends the tracking link over WhatsApp — a coordinator clicks this after
// setting pickup/appointment times, same manual-trigger pattern as sending a
// quote (an automatic send on every edit would spam the patient with reschedules).
apiRouter.post('/logistics/:leadId/send', h(async (req, res) => {
  // Sequenced, not Promise.all'd: upsertLogistics INSERTs a row with this
  // leadId as a foreign key, so running it concurrently with the existence
  // check meant a missing/stale leadId hit a raw Postgres FK-violation 500
  // instead of the clean 404 below.
  const lead = await getLeadChannel(req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const logistics = await upsertLogistics(req.params.leadId, {}); // no-op update, just to read back view_token reliably
  const url = `${config.publicBaseUrl}/panel/itinerary.html?token=${logistics.view_token}`;
  const lang = (req.body?.language || 'en').toLowerCase();
  const caption = (ITINERARY_CAPTIONS[lang] || ITINERARY_CAPTIONS.en)(url);
  try {
    await sendToLead(lead, caption);
  } catch (err) {
    return res.status(502).json({ error: `Send failed: ${err.message}` });
  }
  res.json({ ok: true, url });
}));

// Available WhatsApp templates (for the Campaigns composer).
apiRouter.get('/templates', h(async (_req, res) => {
  res.json(listTemplates());
}));

// Real per-automation status for the Workflow tab — see services/automationStatus.js.
apiRouter.get('/automations', h(async (_req, res) => {
  res.json(await getAutomationStatus());
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
      await recordAgentMessage(lead.id, `[template: ${tpl.name}] ${renderPreview(template, vars)}`);
      sent += 1;
      results.push({ phone: lead.phone, ok: true });
    } catch (err) {
      results.push({ phone: lead.phone, ok: false, error: err.message });
    }
  }
  console.log(`[broadcast] template "${tpl.name}" → segment "${segment}": ${sent}/${leads.length} sent`);
  res.json({ ok: true, template: tpl.name, segment, recipients: leads.length, sent, results });
}));
