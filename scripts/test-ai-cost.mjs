#!/usr/bin/env node
/**
 * Unit tests for src/services/aiCost.js — no network, no API keys, no database.
 *
 *   node scripts/test-ai-cost.mjs
 */
import { computeAiReplyCost, computeAiCostFromTotals, DEFAULT_AI_PRICING } from '../src/services/aiCost.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('▶ computeAiReplyCost()');
{
  check('zero usage → zero cost', computeAiReplyCost({}) === 0);
  check('missing fields default to 0, not NaN', computeAiReplyCost({ inputTokens: 1000 }) > 0 && Number.isFinite(computeAiReplyCost({ inputTokens: 1000 })));

  // 10,000 input + 2,000 output + 5,000 cached-read tokens at default rates.
  const usage = { inputTokens: 10_000, outputTokens: 2_000, cachedReadTokens: 5_000 };
  const expected =
    (10_000 / 1e6) * DEFAULT_AI_PRICING.inputPerMTokUsd +
    (2_000 / 1e6) * DEFAULT_AI_PRICING.outputPerMTokUsd +
    (5_000 / 1e6) * DEFAULT_AI_PRICING.cachedReadPerMTokUsd;
  const got = computeAiReplyCost(usage);
  check('matches manual calculation at default rates', Math.abs(got - expected) < 1e-6, `${got} vs ${expected}`);

  // Custom pricing is honored — proves the module never hardcodes a rate internally.
  const custom = computeAiReplyCost({ inputTokens: 1_000_000 }, { ...DEFAULT_AI_PRICING, inputPerMTokUsd: 5 });
  check('custom pricing overrides the default input rate', custom === 5);

  // Output is much more expensive than input at default rates — sanity check
  // the two rates aren't accidentally swapped.
  const inputOnly = computeAiReplyCost({ inputTokens: 1_000_000 });
  const outputOnly = computeAiReplyCost({ outputTokens: 1_000_000 });
  check('output tokens cost more per-token than input tokens (not swapped)', outputOnly > inputOnly);

  // Cached reads should be cheaper than fresh input tokens.
  const cachedOnly = computeAiReplyCost({ cachedReadTokens: 1_000_000 });
  check('cached-read tokens are cheaper than fresh input tokens', cachedOnly < inputOnly);
}

console.log('\n▶ computeAiCostFromTotals() — same arithmetic, aggregate-shaped input');
{
  const totals = { inputTokens: 50_000, outputTokens: 8_000, cachedReadTokens: 20_000 };
  check('matches computeAiReplyCost on the same numbers', computeAiCostFromTotals(totals) === computeAiReplyCost(totals));

  // Also accepts the llmXTokens naming (as SQL aggregates come back named).
  const sqlShaped = { llmInputTokens: 50_000, llmOutputTokens: 8_000, llmCachedReadTokens: 20_000 };
  check('accepts the llmXTokens field naming too', computeAiCostFromTotals(sqlShaped) === computeAiReplyCost(totals));
}

console.log(`\n${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
