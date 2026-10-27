#!/usr/bin/env node
/**
 * Unit tests for the pure-logic voice modules (safety.js, languages.js,
 * costs.js) — no API keys, no database, no network. These are the pieces
 * that need to be correct before anything touches a real phone call.
 *
 * This is a FIRST increment, not the full voice test suite: scripts/
 * simulate-call.mjs (mock Twilio/STT/TTS, full scripted call scenarios) is
 * built once src/voice/brain.js and session.js exist — see the approved
 * plan (docs/VOICE.md once written).
 *
 *   node scripts/test-voice-helpers.mjs
 */
import { scanForSafetySignal, getSafetyScript } from '../src/voice/safety.js';
import { timezoneForPhone, isWithinLocalHours, resolveVoiceId, DEFAULT_VOICE_ID_BY_LANGUAGE } from '../src/voice/languages.js';
import { computeCallCost, DEFAULT_VOICE_PRICING } from '../src/voice/costs.js';
import { createSentenceChunker } from '../src/voice/brain.js';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('▶ safety.js — scanForSafetySignal()');
{
  const cases = [
    ['en', 'I am bleeding a lot from the area', 'complication'],
    ['en', "I can't breathe properly", 'complication'],
    ['en', 'I want to die, surgery ruined my life', 'crisis'],
    ['en', 'What is the price for a hair transplant?', null],
    ['tr', 'Ameliyat bölgesinden kanama var', 'complication'],
    ['tr', 'nefes alamıyorum', 'complication'],
    ['tr', 'ölmek istiyorum artık', 'crisis'],
    ['tr', 'Saç ekimi ne kadar tutar?', null],
    ['ar', 'عندي نزيف من المنطقة', 'complication'],
    ['ar', 'أريد أن أموت', 'crisis'],
    ['de', 'Ich habe eine starke Blutung', 'complication'],
    ['de', 'Ich will sterben', 'crisis'],
    ['ru', 'У меня сильное кровотечение', 'complication'],
    ['ru', 'я хочу умереть', 'crisis'],
    ['fr', "J'ai un saignement important", 'complication'],
    ['fr', 'je veux me suicider', 'crisis'],
    ['it', 'Ho un sanguinamento forte', 'complication'],
    ['it', 'voglio morire', 'crisis'],
  ];
  for (const [lang, text, expectedType] of cases) {
    const result = scanForSafetySignal(text, lang);
    const got = result?.type || null;
    check(`[${lang}] "${text.slice(0, 40)}" → ${expectedType || 'no match'}`, got === expectedType, `got ${got}`);
  }

  // Unrecognized language code falls back to English patterns rather than throwing.
  const fallback = scanForSafetySignal('I am bleeding', 'xx');
  check('unrecognized lang code falls back to English patterns', fallback?.type === 'complication');

  // Every language has both a complication and a crisis script, and getSafetyScript never returns undefined.
  for (const lang of ['en', 'tr', 'ar', 'de', 'ru', 'fr', 'it']) {
    check(`[${lang}] has a complication script`, typeof getSafetyScript('complication', lang) === 'string' && getSafetyScript('complication', lang).length > 0);
    check(`[${lang}] has a crisis script`, typeof getSafetyScript('crisis', lang) === 'string' && getSafetyScript('crisis', lang).length > 0);
  }
}

console.log('\n▶ languages.js — timezone + hours + voice resolution');
{
  check('TR prefix → Europe/Istanbul', timezoneForPhone('905551234567') === 'Europe/Istanbul');
  check('DE prefix → Europe/Berlin', timezoneForPhone('4915123456789') === 'Europe/Berlin');
  check('unrecognized prefix falls back to clinic timezone', timezoneForPhone('999999999') === 'Europe/Istanbul');
  check('handles a leading +', timezoneForPhone('+905551234567') === 'Europe/Istanbul');

  // Istanbul is UTC+3. 2026-06-15T09:30:00Z is 12:30 local — within 09:00–20:00.
  const midday = new Date('2026-06-15T09:30:00Z');
  check('TR number at 12:30 local is within hours', isWithinLocalHours('905551234567', midday));
  // 2026-06-15T23:30:00Z is 02:30 local the next day — outside 09:00–20:00.
  const lateNight = new Date('2026-06-15T23:30:00Z');
  check('TR number at 02:30 local is outside hours', !isWithinLocalHours('905551234567', lateNight));

  check('resolveVoiceId falls back to the language default (null placeholder) when no profile override', resolveVoiceId('tr', {}) === DEFAULT_VOICE_ID_BY_LANGUAGE.en);
  const profile = { voice: { voiceIdsByLanguage: { tr: 'voice-abc-123' } } };
  check('resolveVoiceId uses the profile override when present', resolveVoiceId('tr', profile) === 'voice-abc-123');
}

console.log('\n▶ costs.js — computeCallCost()');
{
  const zero = computeCallCost({});
  check('zero usage → zero cost', zero.total === 0 && zero.telephony === 0 && zero.stt === 0 && zero.llm === 0 && zero.tts === 0);

  // 3-minute call, 1000 LLM input tok, 500 output tok, 200 cached-read tok, 400 TTS chars, at default rates.
  const usage = { telephonySeconds: 180, sttSeconds: 180, llmInputTokens: 1000, llmOutputTokens: 500, llmCachedReadTokens: 200, ttsCharacters: 400 };
  const result = computeCallCost(usage, DEFAULT_VOICE_PRICING);
  const expectedTelephony = 3 * DEFAULT_VOICE_PRICING.telephonyPerMinUsd;
  const expectedStt = 3 * DEFAULT_VOICE_PRICING.sttPerMinUsd;
  const expectedLlm = (1000 / 1e6) * DEFAULT_VOICE_PRICING.llmInputPerMTokUsd
    + (500 / 1e6) * DEFAULT_VOICE_PRICING.llmOutputPerMTokUsd
    + (200 / 1e6) * DEFAULT_VOICE_PRICING.llmCachedReadPerMTokUsd;
  const expectedTts = (400 / 1000) * DEFAULT_VOICE_PRICING.ttsPerKCharUsd;
  // computeCallCost rounds each figure to 4dp, so compare against that same
  // rounding rather than the raw unrounded value (e.g. 0.00704 → 0.007).
  const TOL = 5e-5;
  check('telephony cost matches manual calc', Math.abs(result.telephony - expectedTelephony) < TOL, `${result.telephony} vs ${expectedTelephony}`);
  check('stt cost matches manual calc', Math.abs(result.stt - expectedStt) < TOL, `${result.stt} vs ${expectedStt}`);
  check('llm cost matches manual calc', Math.abs(result.llm - expectedLlm) < TOL, `${result.llm} vs ${expectedLlm}`);
  check('tts cost matches manual calc', Math.abs(result.tts - expectedTts) < TOL, `${result.tts} vs ${expectedTts}`);
  check('total is the sum of the breakdown', Math.abs(result.total - (result.telephony + result.stt + result.llm + result.tts)) < 1e-6);

  // A custom pricing object is honored instead of the defaults — proves
  // costs.js never hardcodes a rate internally.
  const custom = computeCallCost({ ttsCharacters: 1000 }, { ...DEFAULT_VOICE_PRICING, ttsPerKCharUsd: 1 });
  check('custom pricing overrides the default rate', custom.tts === 1);
}

console.log('\n▶ brain.js — createSentenceChunker() (no API call, pure chunking logic)');
{
  // Simulates how Anthropic's streaming SDK actually delivers tokens: small,
  // arbitrarily-split fragments, not whole words or sentences.
  function runStreamed(fragments) {
    const sentences = [];
    const chunker = createSentenceChunker((s) => sentences.push(s));
    for (const f of fragments) chunker.push(f);
    chunker.flush();
    return sentences;
  }

  check(
    'splits two punctuated sentences delivered as odd-sized fragments',
    JSON.stringify(runStreamed(['Me', 'rha', 'ba! ', 'Nasıl ', 'yard', 'ımcı ', 'ol', 'abilir', 'im?']))
      === JSON.stringify(['Merhaba!', 'Nasıl yardımcı olabilirim?']),
  );

  check(
    'Arabic question mark (؟) is recognized as a sentence end',
    JSON.stringify(runStreamed(['مرحبا', '؟ ', 'كيف حالك؟']))
      === JSON.stringify(['مرحبا؟', 'كيف حالك؟']),
  );

  check(
    'colon counts as a sentence end (price lead-ins, e.g. "Price range:")',
    JSON.stringify(runStreamed(['Price range: ', 'two thousand euros.']))
      === JSON.stringify(['Price range:', 'two thousand euros.']),
  );

  const longUnpunctuated = Array.from({ length: 20 }, (_, i) => `word${i} `);
  const forced = runStreamed(longUnpunctuated);
  check('an unpunctuated run still flushes via the word-count fallback (never blocks forever)', forced.length >= 1 && forced[0].split(/\s+/).length >= 12);

  check('nothing pushed, only flush() → no sentences emitted', runStreamed([]).length === 0);

  // A sentence split mid-fragment across push() calls still comes out whole and trimmed.
  check(
    'a sentence split across many small pushes is reassembled correctly',
    JSON.stringify(runStreamed(['  Hel', 'lo', ' there', '.', '  '])) === JSON.stringify(['Hello there.']),
  );
}

console.log(`\n${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
