#!/usr/bin/env node
/**
 * End-to-end voice-call simulation — mock telephony/STT/TTS/LLM, zero API
 * keys, zero network calls. Exercises the REAL src/voice/session.js turn
 * loop (the actual safety-net/brain/extraction decision logic from the
 * approved plan) with every other piece faked, mirroring how
 * scripts/ai-quality-check.mjs tests the real generateReply() for the text
 * channel.
 *
 * What this DOES verify: the safety-net-vs-brain decision per turn, handover/
 * escalation wiring, multi-turn history (including a WhatsApp-recognized
 * caller's prior messages), mid-call language switching, and per-turn
 * latency bookkeeping.
 *
 * What this does NOT verify (intentionally — these need real accounts, see
 * the approved plan's Faz 0): real Twilio Media Streams audio, real Deepgram
 * transcription accuracy, real ElevenLabs audio, real barge-in timing, or
 * what Claude actually says (brain.js's own Anthropic calls are mocked here,
 * not exercised — see scripts/test-voice-helpers.mjs's live-call note and
 * the session with the user: that verification is blocked on a working
 * ANTHROPIC_API_KEY locally and is explicitly deferred, not skipped by
 * omission).
 *
 *   node scripts/simulate-call.mjs
 */
import { createCallSession } from '../src/voice/session.js';
import { clinicProfile } from '../src/clinic-profile.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// A fake clock so latency numbers are deterministic instead of depending on
// how fast this machine happens to run the mock promises.
function makeFakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** A canned, non-LLM "brain" for scenarios where the safety net is NOT expected to fire. */
function mockBrain({ replyText, sentenceDelays = [40], meta, clock }) {
  let generateCalls = 0;
  let extractCalls = 0;
  const generateReplyStream = async ({ history, onSentence }) => {
    generateCalls++;
    const sentences = replyText.split(/(?<=[.!?])\s+/).filter(Boolean);
    for (let i = 0; i < sentences.length; i++) {
      clock.advance(sentenceDelays[i] ?? sentenceDelays[sentenceDelays.length - 1] ?? 40);
      onSentence(sentences[i]);
    }
    return { fullText: replyText, usage: { inputTokens: 500, outputTokens: 80, cachedReadTokens: 400 } };
  };
  const extractSignal = async () => {
    extractCalls++;
    return { meta, usage: { inputTokens: 300, outputTokens: 40, cachedReadTokens: 250 } };
  };
  return { generateReplyStream, extractSignal, get counts() { return { generateCalls, extractCalls }; } };
}

function mockDeps({ clock, brain }) {
  const spoken = [];
  const turns = [];
  const signals = [];
  let interruptCount = 0;
  const escalations = [];
  return {
    spoken, turns, signals, escalations,
    get interruptCount() { return interruptCount; },
    deps: {
      speak: async (text) => { spoken.push(text); },
      interruptSpeech: () => { interruptCount++; },
      persistTurn: async (role, transcript, opts) => { turns.push({ role, transcript, ...opts }); },
      applySignal: async (meta) => { signals.push(meta); },
      generateReplyStream: brain?.generateReplyStream,
      extractSignal: brain?.extractSignal,
      onEscalation: (info) => { escalations.push(info); },
      now: clock.now,
    },
  };
}

console.log('▶ Scenario: DE price question — no safety trigger, normal reply + non-urgent read');
{
  const clock = makeFakeClock();
  const brain = mockBrain({
    replyText: 'Der Preis für eine Haartransplantation liegt zwischen eintausendneunhundert und dreitausendzweihundert Euro.',
    meta: { detected_language: 'de', lead: { readiness: 'considering', score: 45 }, handover: { needed: false, urgent: false, reason: null } },
    clock,
  });
  const m = mockDeps({ clock, brain });
  const session = createCallSession({ callId: 'sim-de-1', leadId: 'lead-1', profile: clinicProfile, language: 'de', deps: m.deps });
  const result = await session.handleFinalTranscript('Was kostet eine Haartransplantation?', 'de');

  check('safety net did not fire', result.safetyNetFired === false);
  check('brain was called exactly once', brain.counts.generateCalls === 1);
  check('extraction was called exactly once', brain.counts.extractCalls === 1);
  check('reply was spoken', m.spoken.length > 0);
  check('no interruption on a calm turn', m.interruptCount === 0);
  check('no escalation registered', m.escalations.length === 0);
  check('patient + assistant turns both persisted', m.turns.filter((t) => t.role === 'patient').length === 1 && m.turns.filter((t) => t.role === 'assistant').length === 1);
  check('first-sentence latency was measured', Number.isFinite(result.firstSentenceLatencyMs) && result.firstSentenceLatencyMs > 0);
}

console.log('\n▶ Scenario: AR appointment request — non-urgent handover via extraction (wants a human)');
{
  const clock = makeFakeClock();
  const brain = mockBrain({
    replyText: 'بالتأكيد، سأحيلك إلى أحد زملائنا لتأكيد الموعد.',
    meta: { detected_language: 'ar', lead: { readiness: 'ready_to_book', score: 80 }, handover: { needed: true, urgent: false, reason: 'patient wants to book an appointment with a human' } },
    clock,
  });
  const m = mockDeps({ clock, brain });
  const session = createCallSession({ callId: 'sim-ar-1', leadId: 'lead-2', profile: clinicProfile, language: 'ar', deps: m.deps });
  await session.handleFinalTranscript('أريد تأكيد موعدي مع شخص حقيقي', 'ar');

  check('non-urgent handover does not interrupt speech', m.interruptCount === 0);
  check('escalation registered as non-urgent, from extraction', m.escalations.length === 1 && m.escalations[0].source === 'extraction' && m.escalations[0].urgent === false);
  check('session state reflects escalation', session.state.escalated === true);
}

console.log('\n▶ Scenario: RU veneers question — plain reply, state.language updates');
{
  const clock = makeFakeClock();
  const brain = mockBrain({
    replyText: 'Стоимость виниров начинается от ста восемьдесят евро за зуб.',
    meta: { detected_language: 'ru', lead: { readiness: 'researching', score: 30 }, handover: { needed: false, urgent: false, reason: null } },
    clock,
  });
  const m = mockDeps({ clock, brain });
  const session = createCallSession({ callId: 'sim-ru-1', leadId: 'lead-3', profile: clinicProfile, language: null, deps: m.deps });
  await session.handleFinalTranscript('Сколько стоят виниры?', 'ru');
  check('session.state.language updated from the turn', session.state.language === 'ru');
}

console.log('\n▶ Scenario: EN complaint — handover.needed (dissatisfied patient), not urgent');
{
  const clock = makeFakeClock();
  const brain = mockBrain({
    replyText: "I'm really sorry to hear that. I'll make sure our team reaches out to you about this personally.",
    meta: { detected_language: 'en', lead: { readiness: 'considering', score: 20 }, handover: { needed: true, urgent: false, reason: 'patient complaint' } },
    clock,
  });
  const m = mockDeps({ clock, brain });
  const session = createCallSession({ callId: 'sim-en-1', leadId: 'lead-4', profile: clinicProfile, language: 'en', deps: m.deps });
  await session.handleFinalTranscript("I'm really unhappy with how my last visit went.", 'en');
  check('complaint triggers a non-urgent escalation', session.state.escalated === true && session.state.escalationInfo.source === 'extraction');
  check('did not interrupt speech for a non-urgent complaint', m.interruptCount === 0);
}

console.log('\n▶ Scenario: TR complication (emergency) — SAFETY NET MUST FIRE, brain must NEVER be called');
{
  const clock = makeFakeClock();
  // Deliberately a brain that would FAIL the test if it were ever invoked —
  // proves the safety path truly short-circuits before any LLM call, not
  // just that it happens to run first.
  const brain = {
    generateReplyStream: async () => { throw new Error('generateReplyStream must NOT be called when the safety net fires'); },
    extractSignal: async () => { throw new Error('extractSignal must NOT be called when the safety net fires'); },
  };
  const m = mockDeps({ clock, brain });
  const session = createCallSession({ callId: 'sim-tr-emergency', leadId: 'lead-5', profile: clinicProfile, language: 'tr', deps: m.deps });
  const result = await session.handleFinalTranscript('Ameliyat bölgesinden çok kanama var ve nefes almakta zorlanıyorum', 'tr');

  check('safety net fired', result.safetyNetFired === true && result.type === 'complication');
  check('speech was interrupted (clear) before the safety line', m.interruptCount === 1);
  check('a safety script was spoken, in Turkish', m.spoken.length === 1 && m.spoken[0].includes('acil'));
  check('turn marked is_safety_net in persisted call_turns', m.turns.some((t) => t.role === 'assistant' && t.isSafetyNet === true));
  check('lead signal applied with urgent handover + a medical_note', m.signals[0]?.handover?.urgent === true && Boolean(m.signals[0]?.lead?.medical_note));
  check('session.state.escalated is true, source=safety-net', session.state.escalated === true && session.state.escalationInfo.source === 'safety-net');
}

console.log('\n▶ Scenario: self-harm/crisis language (any language) — safety net fires as "crisis", not "complication"');
{
  const clock = makeFakeClock();
  const brain = { generateReplyStream: async () => { throw new Error('must not be called'); }, extractSignal: async () => { throw new Error('must not be called'); } };
  const m = mockDeps({ clock, brain });
  const session = createCallSession({ callId: 'sim-crisis', leadId: 'lead-6', profile: clinicProfile, language: 'en', deps: m.deps });
  const result = await session.handleFinalTranscript('Honestly I just want to die, this surgery ruined everything.', 'en');
  check('classified as crisis, not complication', result.type === 'crisis');
  check('escalated urgently', session.state.escalated === true);
}

console.log('\n▶ Scenario: mid-call language switch (DE → TR across two turns)');
{
  const clock = makeFakeClock();
  const brainDe = mockBrain({ replyText: 'Guten Tag, wie kann ich helfen?', meta: { detected_language: 'de', lead: { readiness: 'researching', score: 20 }, handover: { needed: false, urgent: false, reason: null } }, clock });
  const m = mockDeps({ clock, brain: brainDe });
  const session = createCallSession({ callId: 'sim-switch', leadId: 'lead-7', profile: clinicProfile, language: 'de', deps: m.deps });
  await session.handleFinalTranscript('Hallo, ich habe eine Frage.', 'de');
  check('starts in German', session.state.language === 'de');

  const brainTr = mockBrain({ replyText: 'Tabii, Türkçe devam edebiliriz.', meta: { detected_language: 'tr', lead: { readiness: 'researching', score: 25 }, handover: { needed: false, urgent: false, reason: null } }, clock });
  m.deps.generateReplyStream = brainTr.generateReplyStream;
  m.deps.extractSignal = brainTr.extractSignal;
  await session.handleFinalTranscript('Aslında Türkçe konuşabilir miyiz?', 'tr');
  check('switches to Turkish on the very next turn', session.state.language === 'tr');
  check('history carries both turns (continuity across the switch)', session.state.history.length === 4);
}

console.log('\n▶ Scenario: WhatsApp-recognized caller — prior text history is carried into the call');
{
  const clock = makeFakeClock();
  const priorWhatsAppHistory = [
    { role: 'user', content: 'Merhaba, saç ekimi hakkında bilgi almak istiyorum.' },
    { role: 'assistant', content: 'Merhaba! Memnuniyetle yardımcı olurum, yaşınızı ve ilgi alanınızı öğrenebilir miyim?' },
  ];
  const brain = mockBrain({
    replyText: 'Tekrar hoş geldiniz! WhatsApp\'ta konuştuklarımızı hatırlıyorum, nasıl yardımcı olabilirim?',
    meta: { detected_language: 'tr', lead: { readiness: 'considering', score: 50 }, handover: { needed: false, urgent: false, reason: null } },
    clock,
  });
  const m = mockDeps({ clock, brain });
  const session = createCallSession({
    callId: 'sim-recall', leadId: 'lead-whatsapp-1', profile: clinicProfile, language: 'tr',
    initialHistory: priorWhatsAppHistory,
    deps: m.deps,
  });
  check('session starts with the prior WhatsApp history already loaded', session.state.history.length === 2);
  await session.handleFinalTranscript('Merhaba, tekrar ben.', 'tr');
  check('history after the call turn includes the prior exchange PLUS the new turn', session.state.history.length === 4);
  check('the prior WhatsApp turns are still the first two entries, unmodified', session.state.history[0].content === priorWhatsAppHistory[0].content);
}

console.log('\n▶ Scenario: call finalize — cost/usage accumulate correctly across turns');
{
  const clock = makeFakeClock();
  const brain = mockBrain({ replyText: 'Tabii, memnuniyetle.', meta: { detected_language: 'tr', lead: { readiness: 'researching', score: 20 }, handover: { needed: false, urgent: false, reason: null } }, clock });
  const m = mockDeps({ clock, brain });
  const session = createCallSession({ callId: 'sim-finalize', leadId: 'lead-8', profile: clinicProfile, language: 'tr', deps: m.deps });
  await session.handleFinalTranscript('Bir sorum var.', 'tr');
  await session.handleFinalTranscript('Başka bir sorum daha var.', 'tr');

  const finalizeData = session.getFinalizeData({ telephonySeconds: 90, sttSeconds: 90 });
  check('llm token usage accumulated across both turns', finalizeData.usage.llmInputTokens === (500 + 300) * 2);
  check('tts character usage accumulated', finalizeData.usage.ttsCharacters > 0);
  check('cost breakdown computed and total is positive', finalizeData.costBreakdown.total > 0);
  check('outcome defaults to no_action when nothing escalated', finalizeData.outcome === 'no_action');
}

console.log(`\n${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`);
console.log(
  failed
    ? ''
    : '\nNote: this run used MOCK brain/telephony — it did not verify real Twilio audio, real Deepgram transcripts, real ElevenLabs audio, or what Claude actually says (needs a working ANTHROPIC_API_KEY — see scripts/test-voice-helpers.mjs\'s live-call section, currently blocked). See docs/VOICE.md once written for what Faz 0 still needs to prove.',
);
process.exit(failed ? 1 : 0);
