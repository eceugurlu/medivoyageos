#!/usr/bin/env node
/**
 * Unit tests for scheduler.js::getClinicWeekWindow()'s timezone arithmetic —
 * the actual risk in the weekly-report feature (getting the Monday boundary
 * wrong by a few hours around midnight, in either direction). No network,
 * no API keys, no database.
 *
 *   node scripts/test-weekly-report.mjs
 */
import { getClinicWeekWindow } from '../src/services/scheduler.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Europe/Istanbul is a fixed UTC+3, no DST (since 2016) — every expectation
// below is computed by hand against that fixed offset so a regression here
// would actually be caught, not just re-derived the same way as the code
// under test.

console.log('▶ Monday detection at various clinic-local times');
{
  // 2026-10-26 is a Monday. 10:00 Istanbul = 07:00 UTC that same day.
  const mondayMorning = new Date('2026-10-26T07:00:00Z');
  check('10:00 Monday Istanbul time → isMonday true', getClinicWeekWindow(mondayMorning).isMonday === true);

  // 2026-10-26T00:30Z is 03:30 Istanbul — STILL Monday local, even though the
  // UTC calendar date is also the 26th here (no cross-day subtlety in this
  // particular instant, included as a baseline sanity check).
  const mondayJustAfterMidnightLocal = new Date('2026-10-26T00:30:00Z'); // 03:30 Istanbul
  check('03:30 Monday Istanbul time → isMonday true', getClinicWeekWindow(mondayJustAfterMidnightLocal).isMonday === true);

  // 2026-10-25T22:00Z (Sunday 22:00 UTC) is 2026-10-26T01:00 Istanbul — i.e.
  // the UTC calendar day is still SUNDAY the 25th, but it's already MONDAY
  // in Istanbul. This is the actual boundary case the offset math exists for.
  const utcSundayButLocalMonday = new Date('2026-10-25T22:00:00Z');
  check(
    'UTC says Sunday 22:00, but it is already 01:00 Monday in Istanbul → isMonday true',
    getClinicWeekWindow(utcSundayButLocalMonday).isMonday === true,
  );

  // 2026-10-26T20:30:00Z is 2026-10-26T23:30 Istanbul — still Monday locally,
  // confirming the late end of the day doesn't spill into Tuesday.
  const lateMonday = new Date('2026-10-26T20:30:00Z');
  check('23:30 Monday Istanbul time → isMonday still true', getClinicWeekWindow(lateMonday).isMonday === true);

  // One instant EITHER SIDE of the Monday/Tuesday boundary.
  // 2026-10-26T20:59:59Z = Monday 23:59:59 Istanbul.
  const lastSecondOfMonday = new Date('2026-10-26T20:59:59Z');
  check('23:59:59 Monday Istanbul → isMonday true', getClinicWeekWindow(lastSecondOfMonday).isMonday === true);
  // 2026-10-26T21:00:00Z = Tuesday 00:00:00 Istanbul.
  const firstSecondOfTuesday = new Date('2026-10-26T21:00:00Z');
  check('00:00:00 Tuesday Istanbul → isMonday FALSE', getClinicWeekWindow(firstSecondOfTuesday).isMonday === false);

  const sunday = new Date('2026-10-25T12:00:00Z'); // 15:00 Istanbul Sunday
  check('Sunday afternoon Istanbul time → isMonday false', getClinicWeekWindow(sunday).isMonday === false);
  const friday = new Date('2026-10-23T12:00:00Z');
  check('Friday → isMonday false', getClinicWeekWindow(friday).isMonday === false);
}

console.log('\n▶ weekStart/weekEnd resolve to the correct real UTC instants');
{
  // For any instant during clinic-local Monday 2026-10-26, weekStart must be
  // exactly Monday 2026-10-26 00:00 Istanbul = 2026-10-25T21:00:00.000Z.
  const expectedWeekStartIso = '2026-10-25T21:00:00.000Z';
  const expectedWeekEndIso = '2026-11-01T21:00:00.000Z'; // +7 days

  for (const [label, instant] of [
    ['early Monday', new Date('2026-10-26T00:30:00Z')],
    ['mid Monday', new Date('2026-10-26T12:00:00Z')],
    ['late Monday', new Date('2026-10-26T20:59:00Z')],
    ['Sunday-UTC-but-Monday-local', new Date('2026-10-25T22:00:00Z')],
  ]) {
    const { weekStart, weekEnd } = getClinicWeekWindow(instant);
    check(`[${label}] weekStart == ${expectedWeekStartIso}`, weekStart.toISOString() === expectedWeekStartIso, weekStart.toISOString());
    check(`[${label}] weekEnd == ${expectedWeekEndIso}`, weekEnd.toISOString() === expectedWeekEndIso, weekEnd.toISOString());
  }

  // Also check a non-Monday instant still computes the CURRENT week's
  // boundaries correctly (used by the scheduler to compute "prior week" by
  // subtracting 7 days from this) — Wednesday 2026-10-28 should resolve to
  // the SAME weekStart as the Monday checks above.
  const wednesday = new Date('2026-10-28T10:00:00Z');
  check('Wednesday mid-week resolves to the same weekStart as Monday', getClinicWeekWindow(wednesday).weekStart.toISOString() === expectedWeekStartIso);
}

console.log(`\n${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
