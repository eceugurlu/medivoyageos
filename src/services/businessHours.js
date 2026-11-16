// Mesai Saatleri — TEK yapılandırma noktası.
//
// Hem ROI panosundaki "mesai dışı yanıt" ölçümü (repository.js::getRoiStats)
// hem de yanıt-süresi özelliğinin "mesaiye göre düzeltilmiş süre" hesabı
// (repository.js::getResponseTimeStats) AYNI mesai tanımını kullanır — iki
// yerde ayrı ayrı "09-19" yazıp birini güncellemeyi unutmak, panoların
// birbiriyle çelişmesine yol açardı.
//
// Varsayılan: Pazartesi–Cumartesi 09:00–19:00, Europe/Istanbul. Pazar kapalı.
// Klinik başına değiştirilebilir — bkz. repository.js::getBusinessHoursForBranch
// (clinics.business_hours JSONB; NULL ise bu varsayılan kullanılır).
import { getUtcOffsetMs } from './scheduler.js';

// weekdayIndex burada HER YERDE Pazartesi=0 … Pazar=6 (getClinicWeekWindow'un
// zaten kullandığı aynı kural — scheduler.js'teki weekdayIndex ile tutarlı).
export const DEFAULT_BUSINESS_HOURS = Object.freeze({
  timezone: 'Europe/Istanbul',
  openHour: 9,
  closeHour: 19,
  closedWeekdays: [6], // Pazar
});

// Bir ayar nesnesini doğrular/tamamlar — DB'den gelen bozuk/eksik bir JSONB
// asla patlatmasın, sessizce varsayılana düşsün.
export function normalizeBusinessHours(hours) {
  if (!hours || typeof hours !== 'object') return DEFAULT_BUSINESS_HOURS;
  const openHour = Number(hours.openHour);
  const closeHour = Number(hours.closeHour);
  const timezone = typeof hours.timezone === 'string' && hours.timezone ? hours.timezone : DEFAULT_BUSINESS_HOURS.timezone;
  const closedWeekdays = Array.isArray(hours.closedWeekdays)
    ? hours.closedWeekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : DEFAULT_BUSINESS_HOURS.closedWeekdays;
  if (!Number.isInteger(openHour) || !Number.isInteger(closeHour) || openHour < 0 || closeHour > 24 || openHour >= closeHour) {
    return DEFAULT_BUSINESS_HOURS;
  }
  return { timezone, openHour, closeHour, closedWeekdays };
}

function localParts(date, timezone) {
  const offsetMs = getUtcOffsetMs(date, timezone);
  const local = new Date(date.getTime() + offsetMs); // UTC getters now read local wall-clock
  const weekdayIndex = (local.getUTCDay() + 6) % 7; // getUTCDay(): Sun=0..Sat=6 → Mon=0..Sun=6
  return {
    offsetMs,
    weekdayIndex,
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

export function isWithinBusinessHours(date, hours = DEFAULT_BUSINESS_HOURS) {
  const h = normalizeBusinessHours(hours);
  const p = localParts(date, h.timezone);
  if (h.closedWeekdays.includes(p.weekdayIndex)) return false;
  return p.hour >= h.openHour && p.hour < h.closeHour;
}

// `date` mesai içindeyse `date`'in kendisini döner. Değilse, bir sonraki
// mesai açılış anını (kapalı günleri atlayarak) gerçek bir UTC Date olarak
// döner. Yanıt-süresi özelliğinin "mesai dışı gelen mesajın saati mesai
// açılışından başlar" kuralının tam karşılığı.
export function businessClockStart(date, hours = DEFAULT_BUSINESS_HOURS) {
  const h = normalizeBusinessHours(hours);
  if (isWithinBusinessHours(date, h)) return new Date(date);
  const p = localParts(date, h.timezone);
  let dayOffset = p.hour >= h.closeHour ? 1 : 0;
  for (let i = 0; i < 8; i++) { // en fazla bir hafta kapalı gün olabilir
    const weekdayIndex = (p.weekdayIndex + dayOffset) % 7;
    if (!h.closedWeekdays.includes(weekdayIndex)) {
      // Hedef yerel günün yerel 00:00'ı + openHour — bu anın UTC getter'ları
      // hâlâ "yerel saatmiş gibi" okunuyor; gerçek UTC anına çevirmek için
      // O GÜNÜN kendi ofsetini (DST geçişi ihtimaline karşı yeniden
      // hesaplanmış, önceki ofsetten devşirilmemiş) çıkarıyoruz.
      const localMidnightAsIfUtc = Date.UTC(p.year, p.month, p.day + dayOffset) + h.openHour * 3_600_000;
      const approxUtc = new Date(localMidnightAsIfUtc - p.offsetMs);
      const realOffsetMs = getUtcOffsetMs(approxUtc, h.timezone);
      return new Date(localMidnightAsIfUtc - realOffsetMs);
    }
    dayOffset++;
  }
  throw new Error('businessClockStart: closedWeekdays bir haftanın tamamını kapsıyor, açılış anı yok');
}

// Postgres'in `extract(dow ...)` kuralı (Pazar=0..Cumartesi=6) bizim
// weekdayIndex kuralımızdan (Pazartesi=0..Pazar=6) FARKLI — SQL tarafında
// kullanılacaksa dönüştür.
export function toPgDow(weekdayIndex) {
  return (weekdayIndex + 1) % 7;
}

export function businessHoursLabel(hours = DEFAULT_BUSINESS_HOURS) {
  const h = normalizeBusinessHours(hours);
  const names = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
  const open = names.filter((_, i) => !h.closedWeekdays.includes(i));
  const closed = names.filter((_, i) => h.closedWeekdays.includes(i));
  const time = `${String(h.openHour).padStart(2, '0')}:00–${String(h.closeHour).padStart(2, '0')}:00`;
  if (!open.length) return 'Her gün kapalı';
  // Varsayılan ve benzer ardışık-açık-günler durumları için okunaklı kısa
  // etiket; açık günler ardışık olmayan özel ayarlarda yalnızca uç
  // noktaları gösterir (yaklaşık bir özet, kesin bir takvim değil).
  const dayLabel = open.length === names.length ? 'Her gün' : `${open[0]}–${open[open.length - 1]}`;
  const suffix = closed.length ? ` (${closed.join(', ')} kapalı)` : '';
  return `${dayLabel} ${time}${suffix}`;
}
