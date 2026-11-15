// Dil Doğrulama Kontrolü — gönderilmeden önce AI'ın cevabının hastanın
// diliyle eşleştiğini kontrol eden basit, deterministik kural.
//
// "Yapay zekâ yanlış dilde cevap verirse bizim riskimiz" — bu, cevabı bir
// dil modeline bir daha sormadan (gecikme ve maliyet eklemeden) çalışması
// gereken bir TRİPWIRE. voice/safety.js'in keyword tarama mantığıyla aynı
// ruh: yavaş ve akıllı değil, hızlı ve kaba.
//
// Yöntem üç katmanlı:
//   1) YAZI SİSTEMİ (script) — Kiril → ru, Arap yazısı → ar/ku ayrımı.
//   2) AYIRT EDİCİ HARF — bazı diller hedef kümede TEK BAŞINA bir harfle
//      ayrılır: Azerice'nin "ə"si Türkçe'de hiç yok; Kürtçe Sorani'nin
//      پ/چ/ژ/گ/ڕ/ڵ/ۆ/ێ harfleri standart Arapça alfabesinde hiç yok.
//      Bunlar tahmin değil, alfabelerin kendi tanımı.
//   3) LATİN YAZISI İÇİNDE DURAK SÖZCÜK (stopword) PUANLAMASI — en/de/fr/it/
//      tr/az birbirine en yakın küme; her dilin en sık geçen birkaç
//      bağlacı/zamiri sayılır, en yüksek puan kazanır.
//
// DÜRÜSTLÜK KURALI compliance.js'teki ile aynı: metin çok kısaysa ya da
// hiçbir dil belirgin şekilde öne çıkmıyorsa SONUÇ 'bilinmiyor'dur, bir
// dil UYDURULMAZ. Kısa bir "Tamam" cevabını yanlış dil diye işaretlemek,
// iyi çalışan bir konuşmayı gereksiz yere insana devretmek demektir.

export const SUPPORTED_LANGS = ['en', 'tr', 'de', 'ar', 'ru', 'fr', 'it', 'az', 'ku'];

// Altında güvenilir tahmin yapılamaz. Tek kelimelik bir onay ("Tamam",
// "Ok", "Merci") hemen her dilde var olabilir; yanlış pozitif üretmek,
// hiç kontrol etmemekten kötüdür.
export const MIN_WORDS = 4;
export const MIN_CHARS = 14;

const CYRILLIC_RE = /[Ѐ-ӿ]/g;
const ARABIC_RE = /[؀-ۿ]/g;
const LATIN_RE = /[A-Za-zÀ-ɏ]/g;
// Yalnızca Sorani Kürtçesinde bulunan, standart Arapçada HİÇ olmayan harfler
// (Farsça ile de paylaşılır ama desteklenen dil kümemizde Farsça yok).
const KURDISH_ONLY_RE = /[پچژگڕڵۆێ]/;
// Azerbaycan Latin alfabesinin "ə"si — Türkçe alfabesinde hiç yok.
const AZERI_SCHWA_RE = /ə/i;

// Her dilin en sık geçen, kısa bir AI cevabında bile muhtemelen görünecek
// birkaç fonksiyon kelimesi. Tam liste değil — amaç sözlük değil tripwire.
const STOPWORDS = {
  en: ['the', 'and', 'you', 'your', 'is', 'to', 'for', 'this', 'with', 'we', 'will', 'please', 'can', 'are'],
  de: ['der', 'die', 'das', 'und', 'sie', 'ist', 'für', 'mit', 'wir', 'ihre', 'können', 'bitte', 'nicht', 'auch'],
  fr: ['le', 'la', 'les', 'et', 'vous', 'est', 'pour', 'avec', 'nous', 'votre', 'pouvez', 'merci', 'pas', 'une'],
  it: ['il', 'la', 'le', 'e', 'lei', 'è', 'per', 'con', 'noi', 'suo', 'può', 'grazie', 'non', 'una'],
  // Azerice ve Türkçe birbirine en yakın çift: "ə" harfi ayırt edicidir ama
  // onu içermeyen bir cümle için də/üçün/sizin gibi Azerice'ye özgü
  // bağlaçlar da sayılıyor (Türkçe'de "de"/"için" farklı yazılır).
  az: ['və', 'üçün', 'sizin', 'biz', 'bir', 'dir', 'olacaq', 'xahiş', 'bu', 'də'],
  tr: ['ve', 'için', 'sizin', 'biz', 'bir', 'olacak', 'lütfen', 'bu', 'çok', 'ile'],
};

function countMatches(text, re) {
  return (text.match(re) || []).length;
}

function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{M}]+/gu) || []);
}

function detectScript(text) {
  const cyr = countMatches(text, CYRILLIC_RE);
  const ara = countMatches(text, ARABIC_RE);
  const lat = countMatches(text, LATIN_RE);
  const max = Math.max(cyr, ara, lat);
  if (max === 0) return 'unknown';
  if (max === cyr) return 'cyrillic';
  if (max === ara) return 'arabic';
  return 'latin';
}

/**
 * @returns {{ lang: string|null, confidence: 'high'|'low', script: string, reason?: string }}
 */
export function detectLanguage(text) {
  const t = String(text || '').trim();
  const words = tokenize(t);
  if (t.length < MIN_CHARS || words.length < MIN_WORDS) {
    return { lang: null, confidence: 'low', script: 'unknown', reason: 'too_short' };
  }

  const script = detectScript(t);

  if (script === 'cyrillic') {
    // Hedef kümede tek Kiril dili Rusça — ayrım gerekmiyor.
    return { lang: 'ru', confidence: 'high', script };
  }

  if (script === 'arabic') {
    return {
      lang: KURDISH_ONLY_RE.test(t) ? 'ku' : 'ar',
      confidence: 'high',
      script,
    };
  }

  if (script === 'latin') {
    // "ə" tek başına kesin imza: hiçbir diğer hedef dilin alfabesinde yok.
    if (AZERI_SCHWA_RE.test(t)) return { lang: 'az', confidence: 'high', script };

    const scores = Object.fromEntries(Object.keys(STOPWORDS).map((l) => [l, 0]));
    for (const w of words) {
      for (const [lang, list] of Object.entries(STOPWORDS)) {
        if (list.includes(w)) scores[lang] += 1;
      }
    }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [topLang, topScore] = ranked[0];
    const second = ranked[1][1];
    // Puan 0 ise ya da iki dil başa baş geldiyse karar vermiyoruz — bir
    // dili uydurmak hiç kontrol etmemekten kötü.
    if (topScore === 0 || topScore === second) {
      return { lang: null, confidence: 'low', script, reason: 'ambiguous' };
    }
    return { lang: topLang, confidence: 'high', script };
  }

  return { lang: null, confidence: 'low', script, reason: 'unknown_script' };
}

function normalizeLangCode(lang) {
  return lang ? String(lang).toLowerCase().slice(0, 2) : null;
}

/**
 * Giden cevabın, hastanın beklenen diliyle eşleşip eşleşmediğini kontrol
 * eder. Yalnızca YÜKSEK GÜVENLİ bir tespit gerçek bir uyuşmazlıkla
 * karşılaştığında 'mismatch' döner — düşük güven veya beklenen dilin
 * kendisi bilinmiyorsa karar verilemez ('unknown') sonucu döner, asla
 * sessizce 'ok' sayılmaz ama asla da haksız yere alarm vermez.
 *
 * @returns {{ status: 'ok'|'mismatch'|'unknown', detected: object, expected: string|null }}
 */
export function checkReplyLanguage(replyText, expectedLang) {
  const expected = normalizeLangCode(expectedLang);
  const detected = detectLanguage(replyText);

  if (!expected || !SUPPORTED_LANGS.includes(expected)) {
    return { status: 'unknown', detected, expected, reason: 'no_expected_language' };
  }
  if (detected.confidence !== 'high' || !detected.lang) {
    return { status: 'unknown', detected, expected, reason: detected.reason || 'low_confidence' };
  }
  if (detected.lang === expected) {
    return { status: 'ok', detected, expected };
  }
  return { status: 'mismatch', detected, expected };
}

/**
 * webhook.js'in gönderilmeden hemen önce çağırdığı tripwire. Saf fonksiyon:
 * Express, DB ya da ağ yok — bu yüzden gerçek entegrasyonu Playwright/canlı
 * sunucu olmadan test edebiliyoruz. Yalnızca YÜKSEK GÜVENLİ bir uyuşmazlıkta
 * `reply`'ı değiştirir ve `meta.handover`'ı zorlar; aksi hâlde girdiyi
 * olduğu gibi döner.
 *
 * @param {{reply:string, meta:object, fallbackReply:string}} input
 * @returns {{reply:string, meta:object, guarded:boolean, result:object}}
 */
export function applyLanguageGuard({ reply, meta, fallbackReply }) {
  if (!meta || !meta.detected_language) {
    return { reply, meta, guarded: false, result: null };
  }
  const result = checkReplyLanguage(reply, meta.detected_language);
  if (result.status !== 'mismatch') {
    return { reply, meta, guarded: false, result };
  }
  return {
    reply: fallbackReply,
    meta: {
      ...meta,
      handover: {
        needed: true,
        urgent: false,
        reason: `AI replied in the wrong language (expected ${result.expected}, detected ${result.detected.lang}) — needs a human reply`,
      },
    },
    guarded: true,
    result,
  };
}
