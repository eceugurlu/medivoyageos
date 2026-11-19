import { Router } from 'express';
import { waitUntil } from '@vercel/functions';
import { config } from '../config.js';
import { verifySignature } from '../middleware/verifySignature.js';
import { sendText, downloadMedia, sendTypingIndicator } from '../services/whatsapp.js';
import { sendInstagramText, sendMessengerText, sendTypingAction } from '../services/metaMessaging.js';
import { generateReply } from '../services/concierge.js';
import { transcribeAudio, transcriptionEnabled } from '../services/audioTranscriber.js';
import { loadContext, saveExchange, getLead, setCrmLeadId } from '../store/index.js';
import { attachLeadAttribution } from '../store/repository.js';
import { assignCoordinatorByLanguage } from '../store/repository.js';
import { zohoEnabled, syncLeadToCrm } from '../services/zoho.js';
import { notifyHandover } from '../services/notify.js';
import { recordFailure, recordSuccess } from '../services/healthMonitor.js';
import { applyLanguageGuard } from '../services/langCheck.js';

export const webhookRouter = Router();

// ── 1) Verification handshake ──────────────────────────────────────────────
// Meta calls this once per product, when you save the webhook URL in the App
// Dashboard. One Meta App can subscribe WhatsApp, Instagram, and Messenger to
// this SAME callback URL — Meta tells them apart later via body.object on the
// POST below, not here, so this handshake and its verify token are shared.
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
// Acknowledge Meta immediately, THEN process — but on Vercel a serverless
// function can freeze the instant its response is sent, which would silently
// kill the in-flight AI call/send. waitUntil() tells the platform to keep
// this invocation alive until the promise settles, so we get both: a fast
// ack (Meta's retry timeout is a real risk once transcription/vision steps
// are in the critical path — a slow synchronous response here can trigger a
// duplicate delivery) and reliable completion of the background work.
// Outside Vercel (local dev) waitUntil() is a safe no-op — see
// @vercel/functions' getContext().waitUntil?.(); the promise still runs to
// completion because the local process stays alive regardless.
webhookRouter.post('/', verifySignature, (req, res) => {
  res.sendStatus(200);
  waitUntil(handleEvent(req.body).catch((err) => console.error('[webhook] handler error', err)));
});

// If the AI call fails for ANY reason (no credits, rate limit, Anthropic
// outage, malformed response, …) the patient must still get a reply — silence
// loses a hot lead and looks broken. This is a short, neutral holding message
// that reads fine in the languages the clinic serves, and we always flag the
// conversation for a human to pick up when this path fires.
const FALLBACK_REPLY =
  "Thank you for your message — our team will get back to you shortly.\n" +
  "Vielen Dank für Ihre Nachricht – unser Team meldet sich in Kürze.\n" +
  "شكراً لرسالتك، سيتواصل معك فريقنا قريباً.\n" +
  "Спасибо за ваше сообщение, наша команда скоро свяжется с вами.\n" +
  "Merci pour votre message, notre équipe vous répondra très bientôt.";

// In-process guard: prevents the same Meta message from being processed twice
// concurrently (belt-and-braces on top of the DB-level idempotency dedup).
// Shared across all three channels — a WhatsApp wamid, an Instagram mid, and
// a Messenger mid are never going to collide with each other.
const inFlight = new Set();

async function handleEvent(body) {
  if (body?.object === 'whatsapp_business_account') return handleWhatsAppEntry(body);
  if (body?.object === 'instagram') return handleMetaMessagingEntry(body, 'instagram');
  if (body?.object === 'page') return handleMetaMessagingEntry(body, 'messenger');
  // Unknown object — nothing this app subscribes to; ignore rather than error.
}

// ── WhatsApp ─────────────────────────────────────────────────────────────
async function handleWhatsAppEntry(body) {
  const wamid = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
  if (wamid) {
    if (inFlight.has(wamid)) {
      console.log(`[dedup] ${wamid} already processing — skipping`);
      return;
    }
    inFlight.add(wamid);
  }
  try {
    await _handleWhatsAppEvent(body);
  } finally {
    if (wamid) inFlight.delete(wamid);
  }
}

async function _handleWhatsAppEvent(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;

  // Ignore delivery/read status callbacks (they have `statuses`, not `messages`).
  const message = value?.messages?.[0];
  if (!message) return;

  const from = message.from; // patient's number in E.164 without '+'
  const profileName = value?.contacts?.[0]?.profile?.name || null;

  // Text, photos, and voice notes are all handled directly (photos are the
  // core intake signal for hair/dental/aesthetic triage — see concierge.js's
  // vision section; voice notes are common for patients typing in a foreign
  // keyboard is awkward). Other media (documents, video) still falls back to
  // a text nudge.
  let userText;
  let image = null;
  if (message.type === 'text') {
    userText = message.text.body;
  } else if (message.type === 'image') {
    userText = (message.image?.caption || '').trim() || '[the patient sent a photo with no caption]';
    try {
      image = await downloadMedia(message.image.id, 'image/jpeg');
    } catch (err) {
      console.error(`[whatsapp] failed to download photo from ${from}:`, err.message);
    }
  } else if (message.type === 'audio') {
    // This branch is the one path that chains FOUR separately-timed-out
    // external calls in a single invocation — downloadMedia, transcribeAudio
    // below, then generateReply and the reply send further down this same
    // handler — each kept tight for exactly this reason, but their sum can
    // still exceed Vercel's 30s function budget (vercel.json) in a true
    // worst case where every one of them is independently slow, not hung.
    // A hung step still fails cleanly (that's what those timeouts guarantee);
    // only that specific compounding-slowness scenario isn't fully covered,
    // and closing it for real would need a shared deadline threaded through
    // this whole chain rather than each step's own fixed budget.
    if (!transcriptionEnabled) {
      userText = '[the patient sent a voice message — transcription is not configured on this clinic; acknowledge warmly and ask them to type or call instead]';
    } else {
      try {
        const audio = await downloadMedia(message.audio.id, 'audio/ogg');
        const text = audio ? (await transcribeAudio(audio.buffer, audio.mimeType)).trim() : '';
        userText = text || '[the patient sent a voice message that transcribed empty — acknowledge warmly and ask them to type instead]';
      } catch (err) {
        console.error(`[whisper] failed to transcribe voice note from ${from}:`, err.message);
        userText = '[the patient sent a voice message that could not be transcribed — acknowledge warmly and ask them to type instead]';
      }
    }
  } else {
    userText = '[the patient sent a non-text, non-photo, non-voice message — acknowledge it warmly and ask them to describe their goal in text, or send a photo]';
  }

  console.log(`[msg:whatsapp] from ${profileName || from} (${from}): ${userText}`);

  // Idempotency + history in one call — this is also where the inbound
  // message actually gets claimed/inserted (atomically), BEFORE the AI call
  // below, which is what makes the dedup safe under concurrent retries.
  // Meta retries webhooks; if we've already processed this exact message id,
  // bail before spending an AI call.
  const { duplicate, history, ctx } = await loadContext({
    phone: from,
    source: 'whatsapp',
    name: profileName,
    wamid: message.id,
    userText,
    image,
  });
  if (duplicate) {
    console.log(`[dedup] message ${message.id} already handled — skipping`);
    return;
  }

  // Reklam → Hasta Atfetme. Meta attaches `referral` ONLY when the patient
  // arrived by tapping a Click to WhatsApp ad, and only on that first
  // message — the ad that produced this patient is knowable for exactly one
  // webhook delivery and never again, so it is recorded here rather than
  // anywhere more convenient. Deliberately not awaited into the reply path:
  // attribution is a bookkeeping side effect and must never delay, or fail,
  // a patient's answer. First-touch wins (see attachLeadAttribution).
  if (message.referral) {
    const r = message.referral;
    attachLeadAttribution(ctx.leadId, {
      sourceId: r.source_id,
      sourceType: r.source_type,
      sourceUrl: r.source_url,
      headline: r.headline,
      // Omitted entirely for ads served in WhatsApp Status, per Meta's own
      // webhook reference — so attribution keys off source_id and treats
      // this as a bonus for Conversions API reporting, never a requirement.
      ctwaClid: r.ctwa_clid || null,
    })
      .then((row) => row && console.log(`[attribution] lead ${ctx.leadId} ← ad ${r.source_id}${row.campaign_id ? '' : ' (no campaign registered yet)'}`))
      .catch((err) => console.error('[attribution] failed (non-fatal):', err.message));
  }

  await processConversationTurn({
    channel: 'whatsapp',
    identity: from,
    profileName,
    userText,
    image,
    history,
    ctx,
    sendReply: (text) => sendText(from, text),
    showTyping: () => sendTypingIndicator(message.id),
  });
}

// ── Instagram DM / Facebook Messenger ───────────────────────────────────
// Both ride Meta's Messenger Platform "messaging" event shape — identical
// enough (sender.id, message.mid, message.text, message.attachments) that
// one handler covers both, branching only on which Send API/channel label
// to use. Distinguished up front by body.object: "instagram" vs "page".
async function handleMetaMessagingEntry(body, channel) {
  const messaging = body?.entry?.[0]?.messaging?.[0];
  const mid = messaging?.message?.mid;
  if (mid) {
    if (inFlight.has(mid)) {
      console.log(`[dedup] ${mid} already processing — skipping`);
      return;
    }
    inFlight.add(mid);
  }
  try {
    await _handleMetaMessagingEvent(body, channel);
  } finally {
    if (mid) inFlight.delete(mid);
  }
}

async function _handleMetaMessagingEvent(body, channel) {
  const messaging = body?.entry?.[0]?.messaging?.[0];
  // Ignore delivery receipts, read receipts, and echoes of our own sent
  // messages (is_echo) — only a genuine inbound message has `message` without it.
  if (!messaging?.message || messaging.message.is_echo) return;

  const senderId = messaging.sender?.id;
  if (!senderId) return;

  // Instagram/Messenger hand you the attachment as a direct, already-hosted
  // URL — no separate "resolve media id → CDN url" round trip like WhatsApp
  // needs (see services/whatsapp.js's downloadMedia).
  let userText;
  let image = null;
  const attachment = messaging.message.attachments?.[0];
  if (attachment?.type === 'image') {
    userText = (messaging.message.text || '').trim() || '[the patient sent a photo with no caption]';
    try {
      const res = await fetch(attachment.payload.url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      image = { buffer: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type') || 'image/jpeg' };
    } catch (err) {
      console.error(`[${channel}] failed to download photo from ${senderId}:`, err.message);
    }
  } else if (attachment) {
    userText = `[the patient sent a ${attachment.type} attachment — acknowledge it warmly and ask them to describe their goal in text, or send a photo]`;
  } else {
    userText = (messaging.message.text || '').trim();
  }
  if (!userText && !image) return; // e.g. a "like" sticker with no text or attachment — nothing to act on

  console.log(`[msg:${channel}] from ${senderId}: ${userText}`);

  const { duplicate, history, ctx } = await loadContext({
    externalId: senderId,
    source: channel,
    wamid: messaging.message.mid, // same idempotency column, channel-agnostic in practice
    userText,
    image,
  });
  if (duplicate) {
    console.log(`[dedup] message ${messaging.message.mid} already handled — skipping`);
    return;
  }

  const sendReply = channel === 'instagram'
    ? (text) => sendInstagramText(senderId, text)
    : (text) => sendMessengerText(senderId, text);

  await processConversationTurn({
    channel,
    identity: senderId,
    profileName: null, // neither platform hands over a display name on the message event
    userText,
    image,
    history,
    ctx,
    sendReply,
    showTyping: () => sendTypingAction(senderId, channel),
  });
}

// ── Shared pipeline ──────────────────────────────────────────────────────
// Everything past "we have a userText and a conversation context" is
// identical regardless of which platform the message arrived on: run the AI
// (or fall back), persist the exchange, reply on the right channel, notify a
// human on handover, route to a language-matched coordinator, sync to CRM.
// Only sendReply (and the identity/profileName used for logging) differs.
async function processConversationTurn({ channel, identity, profileName, userText, image, history, ctx, sendReply, showTyping, skipCrm = false }) {
  // If a human agent has taken over this conversation, don't auto-reply.
  // The patient's message is already saved — loadContext() claimed/inserted
  // it atomically before this function was even called — so there's nothing
  // left to do here but stop before the AI pipeline runs.
  if (ctx?.conversationStatus === 'human_handling') {
    console.log(`[takeover] ${identity} is human-handled — inbound saved, AI paused`);
    return;
  }

  // Start the "typing…" bubble before the model call, not after: the whole
  // point is to cover the seconds the patient would otherwise spend looking at
  // a dead thread. Deliberately not awaited — its own latency would land on
  // top of the reply's, inside the same shared 30s budget — and its promise is
  // given a catch so an unhandled rejection can never take the turn down.
  showTyping?.()?.catch?.(() => {});

  let reply;
  let meta;
  let usage;
  try {
    ({ reply, meta, usage } = await generateReply({ history, userText, image }));
    // A single successful call resets the failure streak below — see its
    // own comment for why this one key is threshold+cooldown based (a
    // recoverable blip every so often is normal and not worth paging
    // anyone for) rather than alerted on every single occurrence.
    recordSuccess('ai-concierge');
  } catch (err) {
    // AI failed — don't leave the patient hanging. Send a holding message and
    // force a human handover so nothing falls through the cracks.
    console.error(`[concierge] AI call failed for ${identity}, using fallback reply:`, err.message);
    recordFailure('ai-concierge', {
      threshold: 3, cooldownMs: 15 * 60_000, severity: 'critical',
      title: 'AI concierge repeatedly failing',
      detail: err.message,
    });
    reply = FALLBACK_REPLY;
    usage = null; // the failed call never actually billed any tokens worth recording
    meta = {
      detected_language: null,
      lead: null,
      handover: {
        needed: true,
        // Not urgent: this is an infrastructure failure, not a clinical signal.
        // Still set explicitly — notifyHandover and the panel both read it, and
        // the AI path always supplies it, so leaving it undefined here would be
        // the one shape downstream never sees.
        urgent: false,
        reason: 'AI could not answer (service error) — needs a human reply',
      },
    };
  }

  if (meta) {
    console.log(
      `[lead] score=${meta.lead?.score ?? '?'} lang=${meta.detected_language ?? '?'} readiness=${meta.lead?.readiness ?? '?'}`,
    );
    if (meta.handover?.needed) {
      console.log(`[HANDOVER] ${meta.handover.reason} — patient ${profileName || identity}`);
    }
  }

  // Dil Doğrulama Kontrolü — gönderilmeden ÖNCE son bir tripwire. Model
  // kendi algıladığı dili (meta.detected_language) döndürüyor; cevap o
  // dilde değilse, hastaya yanlış dilde bir mesaj gitmesindense cevabı
  // mevcut çok dilli FALLBACK_REPLY ile değiştirip insana devrediyoruz —
  // modele ikinci bir çağrı YAPMIYORUZ (gecikme/maliyet eklemeden). Karar
  // mantığının tamamı applyLanguageGuard() içinde, saf fonksiyon — Express
  // ya da DB olmadan test edilebiliyor (bkz. scripts/test-lang-check.mjs).
  //
  // Yalnızca YÜKSEK GÜVENLİ bir uyuşmazlıkta devreye girer: kısa ya da
  // belirsiz bir cevap ('unknown') burada hiçbir şeyi tetiklemez — iyi
  // çalışan bir konuşmayı gereksiz yere insana devretmek, sessiz kalmaktan
  // kötüdür.
  const guard = applyLanguageGuard({ reply, meta, fallbackReply: FALLBACK_REPLY });
  reply = guard.reply;
  meta = guard.meta;
  if (guard.guarded) {
    console.error(
      `[lang-check] beklenen=${guard.result.expected} tespit=${guard.result.detected.lang} — ${identity} için cevap değiştirildi`,
    );
    recordFailure('ai-lang-mismatch', {
      threshold: 3, cooldownMs: 15 * 60_000, severity: 'warning',
      title: 'AI repeatedly replying in the wrong language',
      detail: `expected ${guard.result.expected}, detected ${guard.result.detected.lang}`,
    });
  } else if (guard.result) {
    recordSuccess('ai-lang-mismatch');
  }

  // Persist the assistant's reply (Postgres when DATABASE_URL is set, else
  // in-memory) and update the lead from the AI's read of the conversation.
  // The inbound side is already saved — loadContext() claimed/inserted it
  // atomically before the AI call above ever ran.
  await saveExchange(identity, { userText, reply, meta, usage, ctx });

  try {
    await sendReply(reply);
  } catch (err) {
    // Send itself failed (bad token, expired session, rate limit, …). Don't
    // throw — the turn is already recorded and handover already flagged.
    console.error(`[${channel}] failed to deliver reply to ${identity}:`, err.message);
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
      phone: leadRow?.phone || identity, // Instagram/Messenger leads have no phone — the platform id is the closest identifier
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
  if (zohoEnabled && leadRow && !skipCrm) {
    try {
      const crmId = await syncLeadToCrm(leadRow, { lastUserText: userText, lastReply: reply });
      if (crmId && crmId !== leadRow.crm_lead_id) await setCrmLeadId(ctx.leadId, crmId);
    } catch (err) {
      console.error('[zoho] sync failed (non-fatal):', err.message);
    }
  }
}

// ── Panel simülatörü ───────────────────────────────────────────────────────
// Koordinatör panelden "hasta gibi" yazar; mesaj WhatsApp/Instagram ile AYNI
// boru hattından geçer (loadContext → gerçek AI → saveExchange → skor/devir →
// koordinatör ataması → devir bildirimi). Tek farklar: cevap bir kanala
// gönderilmek yerine çağırana döner, lead source='simulator' olarak kaydedilir
// (gelen kutusunda ayrı etiketle görünür) ve CRM'e senkronlanmaz. Demo için
// "gerçek sistem çalışıyor mu" sorusunun dürüst cevabı: kanal hariç her şey
// gerçek.
export async function runSimulatorTurn({ sessionId, name, userText }) {
  const { duplicate, history, ctx } = await loadContext({
    externalId: sessionId,
    source: 'simulator',
    name: name || null,
    wamid: null,
    userText,
    image: null,
  });
  if (duplicate) return { reply: null, leadId: ctx?.leadId || null };
  let captured = null;
  await processConversationTurn({
    channel: 'simulator',
    identity: `simulator:${sessionId}`,
    profileName: name || null,
    userText,
    image: null,
    history,
    ctx,
    sendReply: async (text) => { captured = text; },
    showTyping: null,
    skipCrm: true,
  });
  return { reply: captured, leadId: ctx?.leadId || null };
}
