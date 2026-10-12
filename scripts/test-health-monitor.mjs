#!/usr/bin/env node
/**
 * Unit tests for src/services/healthMonitor.js's threshold/cooldown logic —
 * no network, no API keys, no database. Verifies the actual alerting
 * decisions (when does a failure streak fire, when does it stay quiet, when
 * does recovery clear it) by swapping in a fake notifySystemAlert via
 * module mocking isn't available without a build step here, so instead this
 * drives the real module and asserts on its exported state inspection hooks
 * (_getState) plus console output — good enough to catch a wrong threshold/
 * cooldown comparison, which is the actual risk in this file.
 *
 *   node scripts/test-health-monitor.mjs
 */
import { recordFailure, recordSuccess, _getState, _resetAll } from '../src/services/healthMonitor.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('▶ threshold: no alert before the threshold is reached');
{
  _resetAll();
  recordFailure('k1', { threshold: 3, cooldownMs: 1000 });
  check('1 failure, threshold 3 → not yet alerted (lastAlertAt still 0)', _getState('k1').lastAlertAt === 0);
  recordFailure('k1', { threshold: 3, cooldownMs: 1000 });
  check('2 failures, threshold 3 → still not alerted', _getState('k1').lastAlertAt === 0);
  recordFailure('k1', { threshold: 3, cooldownMs: 1000 });
  check('3rd failure crosses the threshold → alerted', _getState('k1').lastAlertAt > 0);
  check('consecutiveFailures tracked correctly', _getState('k1').consecutiveFailures === 3);
}

console.log('\n▶ cooldown: repeated failures past the threshold do not re-alert within the cooldown window');
{
  _resetAll();
  for (let i = 0; i < 3; i++) recordFailure('k2', { threshold: 3, cooldownMs: 10 * 60_000 });
  const firstAlertAt = _getState('k2').lastAlertAt;
  check('alerted on the 3rd failure', firstAlertAt > 0);
  for (let i = 0; i < 5; i++) recordFailure('k2', { threshold: 3, cooldownMs: 10 * 60_000 });
  check('lastAlertAt unchanged after 5 more failures within the 10-minute cooldown', _getState('k2').lastAlertAt === firstAlertAt);
  check('consecutiveFailures still climbs even while the alert itself is suppressed', _getState('k2').consecutiveFailures === 8);
}

console.log('\n▶ threshold:1 fires on the very first occurrence (process-crash style)');
{
  _resetAll();
  recordFailure('k3', { threshold: 1, cooldownMs: 1000 });
  check('a single failure with threshold:1 alerts immediately', _getState('k3').lastAlertAt > 0);
}

console.log('\n▶ recordSuccess resets the streak and clears the cooldown so a NEW streak can alert promptly');
{
  _resetAll();
  for (let i = 0; i < 3; i++) recordFailure('k4', { threshold: 3, cooldownMs: 10 * 60_000 });
  check('alerted after 3 failures', _getState('k4').lastAlertAt > 0);
  recordSuccess('k4');
  check('consecutiveFailures reset to 0 on success', _getState('k4').consecutiveFailures === 0);
  check('lastAlertAt reset to 0 (not left mid-cooldown)', _getState('k4').lastAlertAt === 0);
  // A brand-new failure streak right after recovery should be able to alert
  // again at the threshold, not be stuck waiting out the OLD cooldown.
  recordFailure('k4', { threshold: 1, cooldownMs: 10 * 60_000 });
  check('a fresh failure streak alerts again immediately after recovery', _getState('k4').lastAlertAt > 0);
}

console.log('\n▶ recordSuccess on a key that never failed is a safe no-op');
{
  _resetAll();
  recordSuccess('never-failed-key');
  check('does not throw, state stays at zero', _getState('never-failed-key').consecutiveFailures === 0);
}

console.log('\n▶ independent keys do not interfere with each other');
{
  _resetAll();
  recordFailure('a', { threshold: 1, cooldownMs: 1000 });
  check('key "a" alerted', _getState('a').lastAlertAt > 0);
  check('key "b" (never touched) is untouched', _getState('b').consecutiveFailures === 0 && _getState('b').lastAlertAt === 0);
}

console.log(`\n${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
