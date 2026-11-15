// Per-language voice selection and best-effort timezone-from-phone-number —
// both deliberately approximate, flagged in docs/VOICE.md rather than
// presented as exact. A single E.164 country code can span several real
// timezones (+1, +7, +61…); this picks one representative zone per prefix,
// good enough to avoid calling a patient at 3am local time, not a geolocation
// substitute.

// ElevenLabs voice ids per language — placeholders until a real ElevenLabs
// account picks actual voices; left blank rather than invented, same
// "unconfigured → dry-run" convention every other integration in this app
// follows (see config.js). A clinic can override per language from the
// panel's voice settings (profile.voice.voiceIdsByLanguage), which wins over
// this default when set.
export const DEFAULT_VOICE_ID_BY_LANGUAGE = {
  en: null,
  tr: null,
  ar: null,
  de: null,
  ru: null,
  fr: null,
  it: null,
  // Azerice ve Kürtçe (Sorani) — Azerbaycan ve Irak doğrulanmış ilk-5
  // kaynak ülke (bkz. src/voice/safety.js'in başındaki not).
  az: null,
  ku: null,
};

export function resolveVoiceId(lang, profile) {
  const key = (lang || 'en').toLowerCase().slice(0, 2);
  const override = profile?.voice?.voiceIdsByLanguage?.[key];
  return override || DEFAULT_VOICE_ID_BY_LANGUAGE[key] || DEFAULT_VOICE_ID_BY_LANGUAGE.en;
}

// E.164 calling-code prefix → one representative IANA timezone. Ordered
// longest-prefix-first so e.g. +212 (Morocco) is checked before a bare +2
// would ever wrongly match something else — not currently an issue with the
// prefixes below, but keeping the order right avoids it becoming one as more
// are added.
const COUNTRY_CODE_TZ = [
  ['90', 'Europe/Istanbul'],   // Türkiye
  ['971', 'Asia/Dubai'],       // UAE
  ['966', 'Asia/Riyadh'],      // Saudi Arabia
  ['20', 'Africa/Cairo'],      // Egypt
  ['962', 'Asia/Amman'],       // Jordan
  ['961', 'Asia/Beirut'],      // Lebanon
  ['49', 'Europe/Berlin'],     // Germany
  ['43', 'Europe/Vienna'],     // Austria
  ['41', 'Europe/Zurich'],     // Switzerland
  ['33', 'Europe/Paris'],      // France
  ['39', 'Europe/Rome'],       // Italy
  ['44', 'Europe/London'],     // UK
  ['31', 'Europe/Amsterdam'],  // Netherlands
  ['34', 'Europe/Madrid'],     // Spain
  ['7', 'Europe/Moscow'],      // Russia — approximate: Russia spans 11 zones
  ['1', 'America/New_York'],   // US/Canada — approximate: spans many zones
];

/** Best-effort: look up a representative timezone from an E.164 phone number. */
export function timezoneForPhone(phone) {
  const digits = String(phone || '').replace(/^\+/, '');
  for (const [prefix, tz] of COUNTRY_CODE_TZ) {
    if (digits.startsWith(prefix)) return tz;
  }
  return 'Europe/Istanbul'; // clinic's own timezone as the safest default
}

/**
 * Is `now` within [startHour, endHour) in the patient's best-guess local
 * timezone? Used to gate outbound calls — never ring a patient outside their
 * own likely daytime, even if the clinic's own hours would otherwise allow it.
 */
export function isWithinLocalHours(phone, now = new Date(), { startHour = 9, endHour = 20 } = {}) {
  const tz = timezoneForPhone(phone);
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now),
  );
  return hour >= startHour && hour < endHour;
}
