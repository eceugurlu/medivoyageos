// Per-call cost computation — a pure function over raw usage counters and a
// rates object, deliberately taking NO config import of its own: every rate
// is a parameter, so costs.js never hardcodes a price (see config.js's
// `config.voice.pricing`, the one place these numbers actually live and can
// be corrected without a code change). calls.cost_breakdown/total_cost_usd
// freeze the *result* of this function at the time a call ends, so a later
// price-config change never rewrites a past call's historical cost — only
// the live config, passed in fresh per call, can affect that.
//
// Default rates are MediVoyage's own research snapshot (see docs/VOICE.md /
// the approved plan) — real provider invoices should replace these before
// cost figures are trusted for billing. Telephony/STT are billed per minute
// by Twilio/Deepgram; LLM per token (million-token rate, Anthropic's own
// pricing unit); TTS per character (ElevenLabs' own pricing unit, quoted as
// USD/1K chars, converted below).
export const DEFAULT_VOICE_PRICING = {
  telephonyPerMinUsd: 0.0085,       // Twilio Media Streams, blended in/outbound estimate
  sttPerMinUsd: 0.0058,             // Deepgram Nova-3, multilingual streaming
  llmInputPerMTokUsd: 2.0,          // claude-sonnet-5 input
  llmOutputPerMTokUsd: 10.0,        // claude-sonnet-5 output
  llmCachedReadPerMTokUsd: 0.2,     // ~0.1x base input, model-dependent — verify against the live account's tier
  ttsPerKCharUsd: 0.055,            // ElevenLabs Flash v2.5
};

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * @param {{telephonySeconds?:number, sttSeconds?:number, llmInputTokens?:number,
 *           llmOutputTokens?:number, llmCachedReadTokens?:number, ttsCharacters?:number}} usage
 * @param {typeof DEFAULT_VOICE_PRICING} [pricing]
 * @returns {{telephony:number, stt:number, llm:number, tts:number, total:number}} USD, each rounded to 4dp
 */
export function computeCallCost(usage = {}, pricing = DEFAULT_VOICE_PRICING) {
  const u = {
    telephonySeconds: Number(usage.telephonySeconds) || 0,
    sttSeconds: Number(usage.sttSeconds) || 0,
    llmInputTokens: Number(usage.llmInputTokens) || 0,
    llmOutputTokens: Number(usage.llmOutputTokens) || 0,
    llmCachedReadTokens: Number(usage.llmCachedReadTokens) || 0,
    ttsCharacters: Number(usage.ttsCharacters) || 0,
  };

  const telephony = (u.telephonySeconds / 60) * pricing.telephonyPerMinUsd;
  const stt = (u.sttSeconds / 60) * pricing.sttPerMinUsd;
  const llm =
    (u.llmInputTokens / 1_000_000) * pricing.llmInputPerMTokUsd +
    (u.llmOutputTokens / 1_000_000) * pricing.llmOutputPerMTokUsd +
    (u.llmCachedReadTokens / 1_000_000) * pricing.llmCachedReadPerMTokUsd;
  const tts = (u.ttsCharacters / 1_000) * pricing.ttsPerKCharUsd;

  const breakdown = { telephony: round4(telephony), stt: round4(stt), llm: round4(llm), tts: round4(tts) };
  return { ...breakdown, total: round4(breakdown.telephony + breakdown.stt + breakdown.llm + breakdown.tts) };
}
