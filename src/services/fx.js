// Live currency conversion for the multi-currency cost/profitability view.
// Frankfurter (ECB reference rates) — free, no API key, no signup. Patients
// pay in EUR/GBP; hospitals, drivers and hotels are usually paid in TRY —
// net profitability only means something once both sides are in one currency,
// so everything here normalizes to EUR (the currency the rest of the app
// already defaults to for quotes/payments).
const CACHE_TTL_MS = 60 * 60 * 1000; // rates don't move fast enough to refetch every request
let cache = { rates: null, fetchedAt: 0, date: null };

// Last-resort rates for when the API is unreachable on a cold start with no
// warm cache. The profitability view flags this case to the user (rates_live
// → "profit.stale"), but the numbers are still shown, so how stale these are
// is the size of the error in them: TRY especially drifts fast, and at the
// previous hardcoded 39 it had become 30% off the real rate — enough to
// overstate a Turkish hospital cost by nearly half and turn a real margin
// into an imaginary one. Refresh these against ECB reference rates
// periodically; they are a floor, not a source of truth.
// Last refreshed: 2026-09-16 (ECB via Frankfurter).
const FALLBACK_RATES = { USD: 1.1537, GBP: 0.8574, TRY: 56.136, CHF: 0.9449 };

export async function getEurRates() {
  if (cache.rates && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rates;
  try {
    // Bounded so a hung request can't block every toEur() call sharing this
    // one cache — it just falls through to the catch below and serves the
    // last-known/fallback rates instead, same as any other fetch failure here.
    const res = await fetch('https://api.frankfurter.dev/v1/latest?from=EUR', { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`FX API HTTP ${res.status}`);
    const data = await res.json();
    cache = { rates: data.rates, fetchedAt: Date.now(), date: data.date };
    return cache.rates;
  } catch (err) {
    console.error('[fx] rate fetch failed, using cache/fallback:', err.message);
    return cache.rates || FALLBACK_RATES;
  }
}

/** Convert `amount` in `currency` to EUR using the latest ECB reference rate. */
export async function toEur(amount, currency) {
  const cur = (currency || 'EUR').toUpperCase();
  if (cur === 'EUR') return amount;
  const rates = await getEurRates();
  const rate = rates[cur];
  if (!rate) return amount; // unknown currency code — pass through rather than silently zeroing it
  return amount / rate;
}

export function isRatesLive() {
  return Boolean(cache.rates) && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}
