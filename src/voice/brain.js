// The voice "brain" — resolves the streaming-vs-safety tension from the
// approved plan by splitting each turn into two SEPARATE Anthropic calls
// instead of concierge.js's one forced-tool-call:
//
//   1. generateVoiceReplyStream() — plain-text, streaming, NO tools. This is
//      what the patient actually hears; nothing blocks it on a full
//      structured JSON object finishing.
//   2. extractTurnSignal() — forced tool-call, same lead/handover schema
//      concierge.js uses (via replySchema.js, so they can never drift),
//      fired AFTER the reply so it never adds to spoken latency. Its result
//      feeds the SAME repository.js functions (applyLeadSignal,
//      markConversationEscalated) the text channel uses.
//
// Both reuse concierge.js's buildSystemPrompt(profile, {channel:'voice'}) —
// one prompt, one source of clinic tone/safety rules, for both channels.
//
// This file does NOT call src/voice/safety.js itself — session.js (the
// per-call orchestrator, not yet built) is responsible for running the
// deterministic safety net on each STT transcript BEFORE deciding whether to
// call generateVoiceReplyStream() at all, and for reacting to extractTurnSignal's
// (slower) handover.urgent as a backstop. Keeping that decision in session.js
// — not here — means this file has no opinion on telephony/audio at all; it
// only turns text in, text/structured-data out.
import Anthropic from '@anthropic-ai/sdk';
import { config, aiEnabled } from '../config.js';
import { buildSystemPrompt } from '../services/concierge.js';
import { DETECTED_LANGUAGE_SCHEMA, LEAD_SCHEMA, HANDOVER_SCHEMA } from '../services/replySchema.js';

// Separate, shorter timeout from concierge.js's 15s: that one is sized
// against VERCEL's 30s function budget (irrelevant here — this runs on the
// always-on voice-server.js, not Vercel). This one is sized against what a
// PATIENT will tolerate as silence on a live call before session.js has to
// give up and speak a scripted fallback line instead (see the spec: "hasta
// asla sessizlikte bırakılmaz"). Deliberately tight.
const VOICE_LLM_TIMEOUT_MS = 10_000;

const anthropic = aiEnabled ? new Anthropic({ apiKey: config.anthropic.apiKey, timeout: VOICE_LLM_TIMEOUT_MS }) : null;

// A turn is spoken as it's generated, sentence by sentence, rather than
// waiting for the full reply — this is most of the latency win streaming
// buys. Sentence-boundary detection here is a pragmatic regex, not real NLP:
// it will occasionally mis-split an abbreviation (not really an issue for
// this app's content — the voice prompt forbids markdown/invented names, and
// patient-facing replies are short, plain sentences by design). Arabic's "؟"
// is included alongside the Latin-script punctuation the other 6 languages
// use. A word-count fallback guarantees an unpunctuated run (a model that
// forgets punctuation, or a long number) still reaches TTS promptly instead
// of blocking on a sentence-ending character that may never arrive.
const SENTENCE_END = /[.!?:؟]+["'’”)\]]?(\s+|$)/;
const MAX_WORDS_BEFORE_FORCED_FLUSH = 12;

/**
 * Stateful sentence chunker: push() streamed text deltas into it, it calls
 * onSentence() with each complete sentence as soon as one is ready. flush()
 * must be called once the stream ends, to emit whatever's left in the buffer.
 * Exported standalone (no network call inside) so it's unit-testable without
 * an API key — see scripts/test-voice-helpers.mjs.
 */
export function createSentenceChunker(onSentence) {
  let buffer = '';

  function push(deltaText) {
    buffer += deltaText;
    let match;
    while ((match = buffer.match(SENTENCE_END))) {
      const cut = match.index + match[0].length;
      const sentence = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut);
      if (sentence) onSentence(sentence);
    }
    const words = buffer.trim().split(/\s+/).filter(Boolean);
    if (words.length >= MAX_WORDS_BEFORE_FORCED_FLUSH) {
      const sentence = buffer.trim();
      buffer = '';
      if (sentence) onSentence(sentence);
    }
  }

  function flush() {
    const sentence = buffer.trim();
    buffer = '';
    if (sentence) onSentence(sentence);
  }

  return { push, flush };
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0 };
}

/**
 * The spoken reply for one turn — streamed, no tool-use, cached system
 * prompt. `onSentence(text)` is called as each complete sentence is ready to
 * hand to TTS; the full text and token usage are returned once the stream
 * ends (for transcript storage / cost tracking — see src/voice/costs.js).
 *
 * @param {{history:{role:'user'|'assistant',content:string}[], userText:string,
 *           profile:object, onSentence?:(text:string)=>void}} args
 */
export async function generateVoiceReplyStream({ history, userText, profile, onSentence }) {
  if (!aiEnabled) {
    const text = `(echo mode: set ANTHROPIC_API_KEY) ${userText}`;
    onSentence?.(text);
    return { fullText: text, usage: emptyUsage() };
  }

  const system = [
    { type: 'text', text: buildSystemPrompt(profile, { channel: 'voice' }), cache_control: { type: 'ephemeral' } },
  ];
  const messages = [...history.map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: userText }];

  const chunker = createSentenceChunker((s) => onSentence?.(s));
  let fullText = '';
  const usage = emptyUsage();

  const stream = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system,
    messages,
    stream: true,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      fullText += event.delta.text;
      chunker.push(event.delta.text);
    } else if (event.type === 'message_start' && event.message?.usage) {
      usage.inputTokens = event.message.usage.input_tokens || 0;
      usage.cachedReadTokens = event.message.usage.cache_read_input_tokens || 0;
      usage.cacheCreationTokens = event.message.usage.cache_creation_input_tokens || 0;
    } else if (event.type === 'message_delta' && event.usage) {
      // Cumulative, per the SDK's own docs — the LAST message_delta event
      // carries the final total, so later events simply overwrite earlier ones.
      usage.outputTokens = event.usage.output_tokens ?? usage.outputTokens;
    }
  }
  chunker.flush();

  return { fullText, usage };
}

const EXTRACT_TOOL = {
  name: 'record_signal',
  description:
    "Record this turn's structured read of the lead and whether a human handover is needed. You already spoke your reply separately — do NOT produce another reply here, only the structured read.",
  input_schema: {
    type: 'object',
    properties: {
      detected_language: DETECTED_LANGUAGE_SCHEMA,
      lead: LEAD_SCHEMA,
      handover: HANDOVER_SCHEMA,
    },
    required: ['detected_language', 'lead', 'handover'],
  },
};

/**
 * The trailing structured extraction for one turn — forced tool-call,
 * non-streaming, fired AFTER the spoken reply (its 1-3s latency never
 * delays speech). Sees the reply that was already given, so its read of the
 * conversation (lead score, handover) is grounded in what the patient
 * actually heard, not just what they said.
 */
export async function extractTurnSignal({ history, userText, replyText, profile }) {
  if (!aiEnabled) return { meta: null, usage: emptyUsage() };

  const system = [
    {
      type: 'text',
      text:
        buildSystemPrompt(profile, { channel: 'voice' }) +
        '\n\n# YOUR JOB RIGHT NOW\nThe reply above has ALREADY been spoken to the patient — you are not generating it here. Call record_signal with your structured read of this turn (detected language, lead fields, handover flags) based on the full exchange below.',
      cache_control: { type: 'ephemeral' },
    },
  ];
  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
    { role: 'assistant', content: replyText },
  ];

  const resp = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 512,
    system,
    messages,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'record_signal' },
  });

  const toolUse = resp.content.find((b) => b.type === 'tool_use' && b.name === 'record_signal');
  if (!toolUse) {
    throw new Error(`Anthropic did not return the expected record_signal tool call (stop_reason: ${resp.stop_reason})`);
  }
  const parsed = toolUse.input;

  return {
    meta: {
      detected_language: parsed.detected_language || null,
      lead: parsed.lead || null,
      handover: parsed.handover || { needed: false, urgent: false, reason: null },
    },
    usage: {
      inputTokens: resp.usage?.input_tokens || 0,
      outputTokens: resp.usage?.output_tokens || 0,
      cachedReadTokens: resp.usage?.cache_read_input_tokens || 0,
      cacheCreationTokens: resp.usage?.cache_creation_input_tokens || 0,
    },
  };
}
