// FX cache/conversion checks — no network, no DB, no keys: global.fetch is
// stubbed so the outage, recovery and concurrency paths are all reachable
// deterministically. Run: npm run check:fx
let attempts = 0;
let mode = 'down';
globalThis.fetch = async () => {
  attempts++;
  if (mode === 'down') throw new Error('simulated FX API outage');
  return { ok: true, json: async () => ({ rates: { USD: 1.10, GBP: 0.85, TRY: 50.0, CHF: 0.94 }, date: '2026-10-27' }) };
};

// Each import() with a fresh query string gives a module with its own cache,
// which is the only way to exercise "cold start" more than once in one run.
const load = () => import(`../src/services/fx.js?t=${Date.now()}-${Math.random()}`);

let failed = 0;
const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) failed++; };

console.log('▶ API down: a per-row conversion loop must not refetch per row');
{
  // Regression guard. toEur() is called row-by-row in getProfitability(),
  // getRoiStats() and getPaymentTotals(); when the fallback was not cached,
  // an outage cost one 8s-timeout fetch PER ROW and blew the 30s function
  // budget — the view died exactly when the fallback should have saved it.
  const fx = await load();
  attempts = 0;
  const rows = [['TRY', 1000], ['TRY', 500], ['USD', 200], ['GBP', 300], ['TRY', 150], ['CHF', 90]];
  let total = 0;
  for (const [cur, amt] of rows) total += await fx.toEur(amt, cur);
  check(`${rows.length} rows cost exactly 1 fetch`, attempts === 1);
  check('fallback rates still produce a finite, positive total', total > 0 && Number.isFinite(total));
  check('isRatesLive() stays false on fallback, so the panel keeps warning', fx.isRatesLive() === false);
}

console.log('\n▶ Concurrent cold callers collapse onto one request');
{
  const fx = await load();
  attempts = 0;
  await Promise.all([fx.toEur(100, 'TRY'), fx.toEur(200, 'USD'), fx.toEur(300, 'GBP'), fx.toEur(400, 'CHF')]);
  check('4 simultaneous callers → 1 fetch', attempts === 1);
}

console.log('\n▶ Recovery: once the API is back, live rates are used and flagged live');
{
  mode = 'up';
  const fx = await load();
  attempts = 0;
  check('TRY converted at the live rate (5000 / 50 = 100)', Math.abs((await fx.toEur(5000, 'TRY')) - 100) < 1e-9);
  check('isRatesLive() is true on real rates', fx.isRatesLive() === true);
  attempts = 0;
  for (let i = 0; i < 10; i++) await fx.toEur(100, 'TRY');
  check('10 further conversions reuse the warm cache (0 fetches)', attempts === 0);
}

console.log('\n▶ Conversion correctness guards');
{
  const fx = await load();
  check('EUR passes through untouched', (await fx.toEur(42, 'EUR')) === 42);
  check('unknown currency passes through rather than silently zeroing', (await fx.toEur(42, 'XYZ')) === 42);
  check('lowercase currency code is normalised', Math.abs((await fx.toEur(5000, 'try')) - 100) < 1e-9);
  check('divides by the rate (TRY→EUR shrinks, not grows)', (await fx.toEur(5000, 'TRY')) < 5000);
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
