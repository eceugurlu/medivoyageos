// Live currency conversion for the multi-currency cost/profitability view.
// Frankfurter (ECB reference rates) — free, no API key, no signup. Patients
// pay in EUR/GBP; hospitals, drivers and hotels are usually paid in TRY —
// net profitability only means something once both sides are in one currency,
// so everything here normalizes to EUR (the currency the rest of the app
// already defaults to for quotes/payments).
const CACHE_TTL_MS = 60 * 60 * 1000; // rates don't move fast enough to refetch every request
// A FAILED lookup is remembered too, for much less time. Callers convert row
// by row (`for (…) await toEur(…)` in getProfitability/getRoiStats/…), so
// without this an outage meant one 8s-timeout fetch PER ROW: six cost rows
// alone exceeded Vercel's 30s maxDuration and took the whole view down with
// them, precisely when the fallback was supposed to keep it standing.
const FAILURE_TTL_MS = 60 * 1000;
let cache = { rates: null, fetchedAt: 0, date: null, live: false };
// Collapses concurrent callers onto one request instead of a thundering herd
// of identical fetches on a cold start.
let inFlight = null;

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
  const ttl = cache.live ? CACHE_TTL_MS : FAILURE_TTL_MS;
  if (cache.rates && Date.now() - cache.fetchedAt < ttl) return cache.rates;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      // Bounded so a hung request can't block every toEur() call sharing this
      // one cache — it just falls through to the catch below and serves the
      // last-known/fallback rates instead, same as any other fetch failure here.
      const res = await fetch('https://api.frankfurter.dev/v1/latest?from=EUR', { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`FX API HTTP ${res.status}`);
      const data = await res.json();
      cache = { rates: data.rates, fetchedAt: Date.now(), date: data.date, live: true };
      return cache.rates;
    } catch (err) {
      console.error('[fx] rate fetch failed, using cache/fallback:', err.message);
      // Keep the last real rates if we ever had them — stale-but-real beats
      // the hardcoded floor. Either way `live: false` keeps the panel's
      // "rates are stale" warning on, so this is never passed off as current.
      const rates = cache.rates || FALLBACK_RATES;
      cache = { rates, fetchedAt: Date.now(), date: cache.date, live: false };
      return rates;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
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
  return cache.live && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}
