// Yanıt Süresi — saf hesaplama. DB yok, ağ yok.
//
// repository.js::getResponseTimeStats() veritabanından ham "tur" satırlarını
// (bir hastanın cevapsız mesaj dizisinin İLK mesajı → onu kapatan ilk
// asistan cevabı) çeker; BU modül sadece o satırlardan ortalama/medyan ve
// mesaiye-göre-düzeltilmiş süreyi hesaplar. Ayrı tutulma nedeni
// complianceSelfCheck.js'teki aynı ayrım: DB'ye dokunmadan birim testiyle
// doğrulanabilsin (bkz. scripts/test-response-time.mjs).
//
// Zaman damgaları DB'de UTC saklanır (TIMESTAMPTZ); burada her hesap
// businessClockStart() üzerinden kliniğin yerel saatine (varsayılan
// Europe/Istanbul) çevrilerek yapılır — bkz. services/businessHours.js.
import { businessClockStart, normalizeBusinessHours } from './businessHours.js';

// n < 5 ise ortalama/medyan gösterilmez — "yetersiz veri" (bkz. panel).
// Bu sayı projede tekrar eden "VERİ YOKSA SKOR YOK" disiplininin
// (compliance.js'teki MIN_PROCESS_SAMPLE'a benzer) yanıt-süresi karşılığı.
export const MIN_RESPONSE_SAMPLE = 5;

function mean(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function summarize(arr) {
  const n = arr.length;
  if (n < MIN_RESPONSE_SAMPLE) {
    return {
      n, status: 'insufficient',
      avg_seconds: null, median_seconds: null,
      avg_business_adjusted_seconds: null, median_business_adjusted_seconds: null,
    };
  }
  return {
    n, status: 'ok',
    avg_seconds: round1(mean(arr.map((x) => x.totalSeconds))),
    median_seconds: round1(median(arr.map((x) => x.totalSeconds))),
    avg_business_adjusted_seconds: round1(mean(arr.map((x) => x.adjustedSeconds))),
    median_business_adjusted_seconds: round1(median(arr.map((x) => x.adjustedSeconds))),
  };
}

/**
 * @param {{askedAt: Date|string|null, repliedAt: Date|string|null, byAi: boolean|null}[]} turns
 * @param {object} businessHours - bkz. normalizeBusinessHours
 */
export function computeResponseTimeStats(turns, businessHours) {
  const hours = normalizeBusinessHours(businessHours);
  const buckets = { ai: [], human: [], unknown: [] };

  for (const t of turns || []) {
    // Hiç cevaplanmamış mesaj: repliedAt yok. Süre 0 veya sonsuz DEĞİL —
    // ölçüme hiç girmez (ne ortalamayı ne medyanı etkiler).
    if (!t || t.askedAt == null || t.repliedAt == null) continue;
    const askedAt = new Date(t.askedAt);
    const repliedAt = new Date(t.repliedAt);
    if (Number.isNaN(askedAt.getTime()) || Number.isNaN(repliedAt.getTime())) continue;
    if (repliedAt <= askedAt) continue; // bozuk/negatif veri — sessizce atılır, patlamaz

    const totalSeconds = (repliedAt.getTime() - askedAt.getTime()) / 1000;
    const clockStart = businessClockStart(askedAt, hours);
    // Mesai dışı gelen bir mesaja mesai açılışından önce (örn. nöbetçi bir
    // insan/AI) cevap verilmişse, mesaiye-göre-düzeltilmiş bekleme negatif
    // değil 0'dır — mesai "açık" sayılan süre hiç geçmemiştir.
    const adjustedSeconds = Math.max(0, (repliedAt.getTime() - clockStart.getTime()) / 1000);

    const key = t.byAi === true ? 'ai' : t.byAi === false ? 'human' : 'unknown';
    buckets[key].push({ totalSeconds, adjustedSeconds });
  }

  return {
    computed_at: new Date().toISOString(),
    business_hours: hours,
    ai: summarize(buckets.ai),
    human: summarize(buckets.human),
    unknown_samples: buckets.unknown.length,
  };
}
