// In-process health tracking for recoverable, repeating failures — AI calls
// failing, the odd blip in an external API. Deliberately NOT used for a
// one-off financially-significant event (a single failed payment-webhook
// confirmation): those are alerted directly and unconditionally wherever
// they happen (see routes/stripeWebhook.js, routes/iyzicoWebhook.js) because
// each one is independently important and a cooldown here would wrongly
// suppress a second, unrelated failure that happens to land soon after the
// first. This module exists for the OPPOSITE case: the same failure
// repeating is the signal (a single blip is normal and not worth paging
// anyone for), so it alerts once a `threshold` is crossed and then goes
// quiet for `cooldownMs` while the SAME key keeps failing, instead of
// flooding the ops channel on every tick.
//
// State lives in memory only (per process) — fine for this app's one
// long-running local server / one warm Vercel function instance at a time;
// a cold start or a different concurrent instance simply starts its own
// count from zero, which just means an outage might take a little longer to
// cross the threshold, never that it goes unnoticed forever.
import { notifySystemAlert } from './notify.js';

const state = new Map(); // key -> { consecutiveFailures, lastAlertAt }

function getState(key) {
  let s = state.get(key);
  if (!s) {
    s = { consecutiveFailures: 0, lastAlertAt: 0 };
    state.set(key, s);
  }
  return s;
}

/**
 * Record one failure for `key`. Once `consecutiveFailures` reaches
 * `threshold`, fires notifySystemAlert — then waits `cooldownMs` before
 * alerting again for the SAME key, even if it keeps failing every call.
 * Never throws (notifySystemAlert is itself best-effort).
 */
export function recordFailure(key, { threshold = 3, cooldownMs = 15 * 60_000, title, detail, severity = 'warning' } = {}) {
  const s = getState(key);
  s.consecutiveFailures += 1;

  if (s.consecutiveFailures >= threshold) {
    const now = Date.now();
    if (now - s.lastAlertAt >= cooldownMs) {
      s.lastAlertAt = now;
      notifySystemAlert({
        severity,
        title: title || `${key} failing`,
        detail,
        consecutiveFailures: s.consecutiveFailures,
      }).catch(() => {});
    }
  }
  return s.consecutiveFailures;
}

/**
 * Record a success for `key` — resets the streak. If an alert had actually
 * fired during the failure streak that just ended, also sends a one-line
 * "recovered" note, so the ops channel isn't left wondering whether anyone
 * ever fixed it.
 */
export function recordSuccess(key) {
  const s = state.get(key);
  if (!s || s.consecutiveFailures === 0) return;
  const hadAlerted = s.lastAlertAt > 0;
  s.consecutiveFailures = 0;
  s.lastAlertAt = 0; // a FUTURE failure streak should be able to alert promptly, not inherit the old cooldown
  if (hadAlerted) {
    notifySystemAlert({ severity: 'ok', title: `${key} recovered`, detail: 'back to normal after failing' }).catch(() => {});
  }
}

// Test/inspection hooks — not meant for production call sites.
export function _getState(key) {
  const s = state.get(key);
  return s ? { ...s } : { consecutiveFailures: 0, lastAlertAt: 0 };
}
export function _resetAll() {
  state.clear();
}
