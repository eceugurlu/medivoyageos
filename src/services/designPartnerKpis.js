// Tasarım Ortağı KPI Paneli — saf hesap.
//
// Girdi: kliniğin kabul ettiği hedef (baseline/target) ve o anın gerçek
// ölçümü. Burada DB yok, ağ yok: ilerleme mantığı gerçek veri olmadan
// test edilebilsin diye. Aynı disiplin compliance.js'teki gibi: ÖLÇÜLEMEYEN
// METRİK "kötü" değil "bilinmiyor"dur, ve iyileşme yönü metrik başına
// değişir (cevap süresi düşsün, dönüşüm oranı yükselsin).

export const METRICS = [
  {
    id: 'response_time_seconds',
    label: 'AI cevap süresi',
    unit: 'seconds',
    direction: 'down', // iyileşme = azalma
  },
  {
    id: 'appointment_conversion_rate',
    label: 'Randevuya dönüşüm',
    unit: 'rate',
    direction: 'up', // iyileşme = artış
  },
];
export const METRIC_IDS = METRICS.map((m) => m.id);

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Bir metrik için ilerleme oranı (0-1) ve durum. baseline/target/current'tan
 * biri eksikse progress null döner — "henüz ölçülemiyor" ile "%0 ilerleme"
 * aynı şey değildir.
 */
export function computeProgress({ metric, baseline, target, current }) {
  const def = METRICS.find((m) => m.id === metric);
  if (!def) throw new Error(`Unknown metric: ${metric}`);

  const have = (v) => v != null && Number.isFinite(Number(v));
  const base = { metric, label: def.label, unit: def.unit, direction: def.direction,
    baseline: have(baseline) ? Number(baseline) : null,
    target: have(target) ? Number(target) : null,
    current: have(current) ? Number(current) : null };

  if (!have(baseline) || !have(target)) {
    return { ...base, progress: null, status: 'no_goal',
      note: 'Bu metrik için henüz başlangıç ve hedef değeri girilmemiş.' };
  }
  if (!have(current)) {
    return { ...base, progress: null, status: 'no_data',
      note: 'Hedef belirlenmiş ama henüz ölçülecek kadar veri yok.' };
  }

  const b = Number(baseline), t = Number(target), c = Number(current);
  // Hedef ile başlangıç aynıysa (kötü girdi) ilerleme tanımsızdır — 0'a
  // bölme yerine açıkça "no_goal" dönülür.
  if (b === t) return { ...base, progress: null, status: 'no_goal', note: 'Başlangıç ve hedef aynı değer — ilerleme tanımsız.' };

  // Yön fark etmeksizin aynı formül: (şu an - başlangıç) / (hedef - başlangıç).
  // 'down' metriklerde hedef başlangıçtan küçük olduğu için payda negatif,
  // ve pay da (iyileşiyorsa) negatif olur — oran yine doğru pozitif çıkar.
  const progress = clamp01((c - b) / (t - b));
  const reached = def.direction === 'down' ? c <= t : c >= t;

  return {
    ...base,
    progress: Math.round(progress * 1000) / 1000,
    status: reached ? 'reached' : progress >= 0.5 ? 'on_track' : 'behind',
    note: reached
      ? 'Hedefe ulaşıldı.'
      : `Yolun %${Math.round(progress * 100)}'i katedildi.`,
  };
}

/**
 * @param {Array<{metric,baseline_value,target_value}>} goals DB satırları
 * @param {Record<string, number|null>} measurements { [metricId]: değer }
 */
export function buildKpiReport(goals, measurements = {}) {
  // Array.isArray şart: `goals || []` yalnızca null/undefined'ı eler, bir
  // string veya obje geçerse `.map` çağrısı TypeError atardı.
  const byMetric = new Map((Array.isArray(goals) ? goals : []).map((g) => [g.metric, g]));
  return METRICS.map((def) => {
    const g = byMetric.get(def.id);
    return computeProgress({
      metric: def.id,
      baseline: g ? g.baseline_value : null,
      target: g ? g.target_value : null,
      current: measurements[def.id],
    });
  });
}
