// Per-call turn orchestration — the concrete implementation of the approved
// plan's "Decision 2" (streaming spoken reply vs. the safety net vs. the
// trailing structured extraction, see docs/VOICE.md once written). This file
// has NO idea what Twilio/Deepgram/ElevenLabs actually are: it is handed a
// `deps` object by its caller (voice-server.js, not yet built — needs real
// provider accounts) and only calls those. That split is deliberate, not
// incidental: it is what lets this file's actual decision logic — the part
// that matters for patient safety — be fully unit-tested today, with mocks,
// before a single real phone call exists. See scripts/simulate-call.mjs.
//
// Every dependency has a real-production default (the actual safety.js/
// brain.js/repository.js functions) so a real caller only needs to override
// the transport-shaped ones (speak, interruptSpeech, persistTurn, applySignal,
// onEscalation) — never the decision logic itself.
import { scanForSafetySignal as defaultScanSafety, getSafetyScript as defaultGetSafetyScript } from './safety.js';
import { generateVoiceReplyStream as defaultGenerateReplyStream, extractTurnSignal as defaultExtractSignal } from './brain.js';
import { computeCallCost } from './costs.js';

function emptyUsageTotals() {
  return { telephonySeconds: 0, sttSeconds: 0, llmInputTokens: 0, llmOutputTokens: 0, llmCachedReadTokens: 0, ttsCharacters: 0 };
}

/**
 * @param {object} args
 * @param {string} args.callId
 * @param {string|null} args.leadId
 * @param {object} args.profile — the clinic profile (same one concierge.js uses)
 * @param {string} [args.language] — initial best-guess language (e.g. from caller ID country), may change per turn
 * @param {{role:'user'|'assistant', content:string}[]} [args.initialHistory] — prior
 *   turns to seed the brain with, e.g. that lead's past WhatsApp messages
 *   (same shape loadContext() returns) when resolveLeadForCall() matched an
 *   existing lead by phone — this is the actual mechanism behind "a patient
 *   recognized from WhatsApp gets their history recalled on a call": the
 *   caller (voice-server.js) loads it, this file just carries it forward.
 * @param {object} args.deps — see module doc above. Required: speak, interruptSpeech,
 *   persistTurn, applySignal. Optional with real-logic defaults: scanSafety,
 *   getSafetyScript, generateReplyStream, extractSignal, onEscalation, now.
 */
export function createCallSession({ callId, leadId, profile, language, initialHistory = [], deps }) {
  const {
    speak,
    interruptSpeech,
    persistTurn,
    applySignal,
    scanSafety = defaultScanSafety,
    getSafetyScript = defaultGetSafetyScript,
    generateReplyStream = defaultGenerateReplyStream,
    extractSignal = defaultExtractSignal,
    onEscalation = () => {},
    now = () => Date.now(),
  } = deps || {};

  if (!speak || !interruptSpeech || !persistTurn || !applySignal) {
    throw new Error('createCallSession: speak, interruptSpeech, persistTurn, and applySignal are required deps');
  }

  const state = {
    history: /** @type {{role:'user'|'assistant', content:string}[]} */ ([...initialHistory]),
    language: language || null,
    escalated: false,
    escalationInfo: null,
    usage: emptyUsageTotals(),
    turnCount: 0,
  };

  function addUsage(delta) {
    for (const key of Object.keys(state.usage)) {
      if (Number.isFinite(delta?.[key])) state.usage[key] += delta[key];
    }
  }

  function markEscalated(info) {
    if (state.escalated) return; // already escalating — don't re-fire onEscalation for the same call
    state.escalated = true;
    state.escalationInfo = info;
    onEscalation(info);
  }

  /**
   * Handle one complete patient utterance (Deepgram's final transcript for
   * this turn — session.js does not do its own endpointing). This is the
   * ENTIRE per-turn decision from the approved plan:
   *   1. deterministic safety net, checked FIRST, on the given text
   *   2. if clear: streamed spoken reply (no tools) + trailing structured
   *      extraction (tool-forced), run concurrently — the extraction never
   *      delays speech, but if IT finds an urgent handover, that still
   *      interrupts/escalates, just a turn later than the keyword net would.
   */
  async function handleFinalTranscript(patientText, detectedLanguage) {
    state.turnCount += 1;
    const lang = detectedLanguage || state.language || 'en';
    state.language = lang;

    await persistTurn('patient', patientText, {});
    state.history.push({ role: 'user', content: patientText });

    const safetyHit = scanSafety(patientText, lang);
    if (safetyHit) {
      const script = getSafetyScript(safetyHit.type, lang);
      interruptSpeech();
      await speak(script);
      await persistTurn('assistant', script, { isSafetyNet: true });
      state.history.push({ role: 'assistant', content: script });

      const meta = {
        detected_language: lang,
        lead: { readiness: 'considering', score: 100, medical_note: `Sesli arama güvenlik ağı tetiklendi: ${safetyHit.type} ("${safetyHit.matched}")` },
        handover: { needed: true, urgent: true, reason: `voice safety-net: ${safetyHit.type}` },
      };
      await applySignal(meta);
      markEscalated({ source: 'safety-net', type: safetyHit.type, matched: safetyHit.matched, turn: state.turnCount });
      return { safetyNetFired: true, type: safetyHit.type };
    }

    const turnStart = now();
    let firstSentenceLatencyMs = null;
    const { fullText, usage: replyUsage } = await generateReplyStream({
      history: state.history,
      userText: patientText,
      profile,
      onSentence: (sentence) => {
        if (firstSentenceLatencyMs === null) firstSentenceLatencyMs = now() - turnStart;
        speak(sentence);
      },
    });
    addUsage({ llmInputTokens: replyUsage.inputTokens, llmOutputTokens: replyUsage.outputTokens, llmCachedReadTokens: replyUsage.cachedReadTokens });
    addUsage({ ttsCharacters: fullText.length });

    await persistTurn('assistant', fullText, { latencyMs: firstSentenceLatencyMs });
    state.history.push({ role: 'assistant', content: fullText });

    // Trailing extraction — deliberately AFTER the reply has already been
    // spoken/persisted above, never blocking it. A failure here must not take
    // the call down: the patient already got a safe, on-topic reply either way.
    try {
      const { meta, usage: extractUsage } = await extractSignal({
        history: state.history.slice(0, -2), // the prior context, not this turn's own two messages — matches extractTurnSignal's own {history, userText, replyText} shape
        userText: patientText,
        replyText: fullText,
        profile,
      });
      addUsage({ llmInputTokens: extractUsage.inputTokens, llmOutputTokens: extractUsage.outputTokens, llmCachedReadTokens: extractUsage.cachedReadTokens });
      if (meta) {
        await applySignal(meta);
        if (meta.handover?.urgent && !state.escalated) {
          // The slower backstop: the keyword net missed it, but the model's
          // own structured read caught it a turn late. Still worth
          // interrupting whatever's queued right now.
          interruptSpeech();
          markEscalated({ source: 'extraction', reason: meta.handover.reason, turn: state.turnCount });
        } else if (meta.handover?.needed && !state.escalated) {
          markEscalated({ source: 'extraction', urgent: false, reason: meta.handover.reason, turn: state.turnCount });
        }
      }
    } catch (err) {
      console.error(`[voice:${callId}] extractTurnSignal failed (non-fatal, reply already delivered):`, err.message);
    }

    return { safetyNetFired: false, firstSentenceLatencyMs };
  }

  /** Call-level housekeeping once the call is over — computes the frozen cost breakdown. */
  function getFinalizeData({ status, outcome, summary, telephonySeconds, sttSeconds, pricing } = {}) {
    if (Number.isFinite(telephonySeconds)) state.usage.telephonySeconds = telephonySeconds;
    if (Number.isFinite(sttSeconds)) state.usage.sttSeconds = sttSeconds;
    const costBreakdown = computeCallCost(state.usage, pricing);
    return {
      status: status || (state.escalated ? 'completed' : 'completed'),
      outcome: outcome || (state.escalated ? 'handed_over' : 'no_action'),
      summary: summary || null,
      language: state.language,
      usage: state.usage,
      costBreakdown,
      totalCostUsd: costBreakdown.total,
    };
  }

  return {
    callId,
    leadId,
    handleFinalTranscript,
    getFinalizeData,
    get state() {
      // Shallow snapshot — callers (tests, the live-handover poll) must not
      // be able to mutate internal state through this getter.
      return { ...state, usage: { ...state.usage }, history: [...state.history] };
    },
  };
}
