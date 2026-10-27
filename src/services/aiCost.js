// Pure cost arithmetic for text-channel AI usage — deliberately takes NO
// config import of its own, same reasoning as the rest of this app's cost
// code: every rate is a parameter, so this file never hardcodes a price
// that then has to be found and changed in two places. config.js's
// `config.ai.pricing` is the one place these numbers actually live.
//
// Default rates are claude-sonnet-5's own published pricing (checked at the
// time this was written — Anthropic can change pricing, so these should be
// treated as a snapshot to verify against the live account, not a promise).
export const DEFAULT_AI_PRICING = {
  inputPerMTokUsd: 2.0,
  outputPerMTokUsd: 10.0,
  cachedReadPerMTokUsd: 0.2, // ~0.1x base input — verify against the live account's tier
};

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * @param {{inputTokens?:number, outputTokens?:number, cachedReadTokens?:number}} usage
 * @param {typeof DEFAULT_AI_PRICING} [pricing]
 * @returns {number} USD, rounded to 4dp
 */
export function computeAiReplyCost(usage = {}, pricing = DEFAULT_AI_PRICING) {
  const inputTokens = Number(usage.inputTokens) || 0;
  const outputTokens = Number(usage.outputTokens) || 0;
  const cachedReadTokens = Number(usage.cachedReadTokens) || 0;

  const cost =
    (inputTokens / 1_000_000) * pricing.inputPerMTokUsd +
    (outputTokens / 1_000_000) * pricing.outputPerMTokUsd +
    (cachedReadTokens / 1_000_000) * pricing.cachedReadPerMTokUsd;

  return round4(cost);
}

/**
 * Same computation, but over already-SUMMED token totals (e.g. a month's
 * worth, aggregated by SQL) rather than one reply's usage — kept as a
 * separate named entry point so a call site reads clearly either way,
 * even though the arithmetic is identical.
 */
export function computeAiCostFromTotals(totals, pricing = DEFAULT_AI_PRICING) {
  return computeAiReplyCost(
    {
      inputTokens: totals.inputTokens ?? totals.llmInputTokens,
      outputTokens: totals.outputTokens ?? totals.llmOutputTokens,
      cachedReadTokens: totals.cachedReadTokens ?? totals.llmCachedReadTokens,
    },
    pricing,
  );
}
