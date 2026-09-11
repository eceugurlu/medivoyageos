import { Router } from 'express';
import { config } from '../config.js';
import { verifySignature } from '../middleware/verifySignature.js';
import { sendText } from '../services/whatsapp.js';
import { generateReply } from '../services/concierge.js';
import { loadContext, saveExchange, saveInboundMessage, getLead, setCrmLeadId } from '../store/index.js';
import { assignCoordinatorByLanguage } from '../store/repository.js';
import { zohoEnabled, syncLeadToCrm } from '../services/zoho.js';
import { notifyHandover } from '../services/notify.js';

export const webhookRouter = Router();

// ── 1) Verification handshake ──────────────────────────────────────────────
// Meta calls this once, when you save the webhook URL in the App Dashboard.
webhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('[webhook] verified ✓');
    return res.status(200).send(challenge);
  }
  console.warn('[webhook] verification failed');
  return res.sendStatus(403);
});

// ── 2) Incoming events (messages, delivery statuses, …) ────────────────────
webhookRouter.post('/', verifySignature, (req, res) => {
  // Acknowledge immediately so Meta doesn't retry; then process asynchronously.
  res.sendStatus(200);
  handleEvent(req.body).catch((err) => console.error('[webhook] handler error', err));
});

// If the AI call fails for ANY reason (no credits, rate limit, Anthropic
// outage, malformed response, …) the patient must still get a reply — silence
// loses a hot lead and looks broken. This is a short, neutral holding message
// that reads fine in the languages the clinic serves, and we always flag the
// conversation for a human to pick up when this path fires.
const FALLBACK_REPLY =
  "Thank you for your message — our team will get back to you shortly. 🙏\n" +
  "Vielen Dank für Ihre Nachricht – unser Team meldet sich in Kürze.\n" +
  "شكراً لرسالتك، سيتواصل معك فريقنا قريباً.\n" +
  "Спасибо за ваше сообщение, наша команда скоро свяжется с вами.\n" +
  "Merci pour votre message, notre équipe vous répondra très bientôt.";

// In-process guard: prevents the same Meta message from being processed twice
// concurrently (belt-and-braces on top of the DB-level idempotency dedup).
const inFlight = new Set();

async function handleEvent(body) {
  const wamid = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
  if (wamid) {
    if (inFlight.has(wamid)) {
      console.log(`[dedup] ${wamid} already processing — skipping`);
      return;
    }
    inFlight.add(wamid);
  }
  try {
    await _handleEvent(body);
  } finally {
    if (wamid) inFlight.delete(wamid);
  }
}

async function _handleEvent(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;

  // Ignore delivery/read status callbacks (they have `statuses`, not `messages`).
  const message = value?.messages?.[0];
  if (!message) return;

  const from = message.from; // patient's number in E.164 without '+'
  const profileName = value?.contacts?.[0]?.profile?.name || null;

  // MVP handles text. Media (photos/audio) → a later step with Claude vision.
  let userText;
  if (message.type === 'text') {
    userText = message.text.body;
  } else {
    userText = '[the patient sent a non-text message, e.g. a photo — acknowledge it warmly and ask them to also describe their goal in text]';
  }

  console.log(`[msg] from ${profileName || from} (${from}): ${userText}`);

  // Idempotency + history in one call. Meta retries webhooks; if we've already
  // processed this exact message id, bail before spending an AI call.
  const { duplicate, history, ctx } = await loadContext(from, {
    name: profileName,
    wamid: message.id,
  });
  if (duplicate) {
    console.log(`[dedup] message ${message.id} already handled — skipping`);
    return;
  }

  // If a human agent has taken over this conversation, don't auto-reply.
  // Just record the patient's message so the agent sees it in the panel.
  if (ctx?.conversationStatus === 'human_handling') {
    await saveInboundMessage(ctx, { userText, wamid: message.id });
    console.log(`[takeover] ${from} is human-handled — inbound saved, AI paused`);
    return;
  }

  let reply;
  let meta;
  try {
    ({ reply, meta } = await generateReply({ history, userText }));
  } catch (err) {
    // AI failed — don't leave the patient hanging. Send a holding message and
    // force a human handover so nothing falls through the cracks.
    console.error(`[concierge] AI call failed for ${from}, using fallback reply:`, err.message);
    reply = FALLBACK_REPLY;
    meta = {
      detected_language: null,
      lead: null,
      handover: {
        needed: true,
        // This lands in the panel's Action Center in front of a coordinator, so
        // it has to read as a sentence. The provider's raw error body — which
        // used to be pasted in here verbatim — stays in the log line above.
        reason: 'AI could not answer (service error) — needs a human reply',
      },
    };
  }

  if (meta) {
    console.log(
      `[lead] score=${meta.lead?.score ?? '?'} lang=${meta.detected_language ?? '?'} readiness=${meta.lead?.readiness ?? '?'}`,
    );
    if (meta.handover?.needed) {
      console.log(`[HANDOVER] ${meta.handover.reason} — patient ${profileName || from}`);
      // Next step plugs in here:
      //   • CRM  → upsert this lead into Zoho (meta.lead maps to Lead fields)
      //   • Ping → notify a human via Slack/email/WhatsApp template
    }
  }

  // Persist the exchange (Postgres when DATABASE_URL is set, else in-memory).
  // Includes the inbound message id so retries can be deduped next time.
  await saveExchange(from, {
    userText,
    inboundWamid: message.id,
    reply,
    meta,
    ctx,
  });

  try {
    await sendText(from, reply);
  } catch (err) {
    // WhatsApp send itself failed (e.g. bad token, 24h window closed).
    // Don't throw — the turn is already recorded and handover already flagged.
    console.error(`[whatsapp] failed to deliver reply to ${from}:`, err.message);
  }

  // Fetch the freshest merged lead row once, for both notification and CRM sync.
  let leadRow = null;
  if (ctx?.leadId) {
    try {
      leadRow = await getLead(ctx.leadId);
    } catch (err) {
      console.error('[lead] read failed:', err.message);
    }
  }

  // ── Handover notification ──────────────────────────────────────────────────
  // Ping a human only on the transition INTO escalation (not on every follow-up
  // message), so the agent isn't spammed. Shows in the panel queue regardless.
  const wasEscalated = ['needs_human', 'human_handling'].includes(ctx?.conversationStatus);
  if (meta?.handover?.needed && !wasEscalated) {
    notifyHandover({
      name: leadRow?.name || profileName,
      phone: from,
      reason: meta.handover.reason,
      urgent: meta.handover?.urgent,
      medicalNote: leadRow?.medical_note,
      score: leadRow?.score,
      language: leadRow?.language,
      treatment: leadRow?.treatment_interest,
    });
  }

  // Route the lead to a coordinator who speaks its language (once known).
  if (ctx?.leadId && meta?.detected_language) {
    try {
      await assignCoordinatorByLanguage(ctx.leadId, meta.detected_language);
    } catch (err) {
      console.error('[matching] coordinator assign failed:', err.message);
    }
  }

  // ── CRM sync (Zoho) ────────────────────────────────────────────────────────
  // Runs AFTER the reply is sent, so Zoho latency never delays the patient.
  // Best-effort: a CRM failure is logged and swallowed.
  if (zohoEnabled && leadRow) {
    try {
      const crmId = await syncLeadToCrm(leadRow, { lastUserText: userText, lastReply: reply });
      if (crmId && crmId !== leadRow.crm_lead_id) await setCrmLeadId(ctx.leadId, crmId);
    } catch (err) {
      console.error('[zoho] sync failed (non-fatal):', err.message);
    }
  }
}