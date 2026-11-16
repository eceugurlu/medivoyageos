// Aylık Uyum Raporu — tek sayfalık PDF için veri hazırlığı.
//
// Yönetmelik 7/24 yabancı dilde iletişim ve hasta takibi istiyor; bu rapor
// o iddiayı tek sayfada somutlaştırır: yanıt süreleri, dillere göre mesaj
// sayısı, takip edilen hasta sayısı. Akreditasyon dosyasına eklenecek kanıt.
//
// Hiçbir şey SAKLANMAZ — rapor istendiği anda gerçek veriden hesaplanır,
// tıpkı haftalık rapor ve Risk & Uyum skoru gibi. Ay penceresi
// scheduler.js'in hafta penceresiyle AYNI UTC-ofset tekniğini kullanır
// (getUtcOffsetMs, REPORT_TIMEZONE) — iki yerde iki farklı "hafta/ay nedir"
// tanımı olursa raporlar birbirini yalanlar.

import { getUtcOffsetMs, REPORT_TIMEZONE } from './scheduler.js';

/**
 * Kliniğin yerel saatine göre takvim ayı penceresi (UTC instant'lara
 * çevrilmiş). offsetMonths=0 → içinde bulunulan ay; -1 → geçen ay (rapor
 * genelde tamamlanmış bir ayı anlatır, hâlâ süren bir ayı değil).
 */
export function getClinicMonthWindow(now = new Date(), offsetMonths = 0) {
  const offsetMs = getUtcOffsetMs(now, REPORT_TIMEZONE);
  const localNow = new Date(now.getTime() + offsetMs);
  const y = localNow.getUTCFullYear();
  const m = localNow.getUTCMonth() + offsetMonths;
  const localMonthStartAsUtc = Date.UTC(y, m, 1);
  const localNextMonthStartAsUtc = Date.UTC(y, m + 1, 1);
  const monthStart = new Date(localMonthStartAsUtc - offsetMs);
  const monthEnd = new Date(localNextMonthStartAsUtc - offsetMs);
  return { monthStart, monthEnd };
}

/** "2026-10" gibi bir ay etiketi, klinik yerel tarihinden. */
export function monthLabel(monthStart) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit' })
    .format(monthStart); // en-CA → YYYY-MM biçimi
}

/**
 * Ham sayılardan raporu derler. Girdi repository'den gelir; burada hiç SQL
 * yok, saf dönüşüm — böylece DB olmadan test edilebilir.
 *
 * @param {object} raw { newLeads, qualifiedLeads, appointmentsBooked,
 *   messagesByLanguage:[{language,count}], avgResponseSeconds, repliedTurns,
 *   postOpDue, postOpSent, nightMessages, nightReplied }
 */
export function buildComplianceReport(input) {
  // `= {}` varsayılanı yalnızca `undefined` için devreye girer — `null`
  // geçilirse yine de `raw.X` erişimi TypeError atardı. Bu oturumda birkaç
  // kez düzelttiğim aynı hata sınıfı; burada baştan kapatıyoruz.
  const raw = input && typeof input === 'object' ? input : {};
  const messagesByLanguage = Array.isArray(raw.messagesByLanguage) ? raw.messagesByLanguage : [];
  const totalMessages = messagesByLanguage.reduce((s, r) => s + Number(r.count || 0), 0);
  const distinctLanguages = messagesByLanguage.filter((r) => r.language).length;

  const postOpDue = Number(raw.postOpDue || 0);
  const postOpSent = Number(raw.postOpSent || 0);
  // Vadesi hiç gelmemişse oran tanımsızdır — 0 görev/0 görev "%100 takip"
  // değil, "henüz ölçülecek bir şey yok"tur.
  const followUpRate = postOpDue > 0 ? Math.round((postOpSent / postOpDue) * 1000) / 10 : null;

  const nightMessages = Number(raw.nightMessages || 0);
  const nightReplied = Number(raw.nightReplied || 0);
  const nightCoverageRate = nightMessages > 0 ? Math.round((nightReplied / nightMessages) * 1000) / 10 : null;

  return {
    new_leads: Number(raw.newLeads || 0),
    qualified_leads: Number(raw.qualifiedLeads || 0),
    appointments_booked: Number(raw.appointmentsBooked || 0),
    avg_response_seconds: raw.avgResponseSeconds == null ? null : Math.round(Number(raw.avgResponseSeconds)),
    replied_turns: Number(raw.repliedTurns || 0),
    messages_by_language: messagesByLanguage
      .map((r) => ({
        language: r.language || null,
        count: Number(r.count || 0),
        share: totalMessages > 0 ? Math.round((Number(r.count || 0) / totalMessages) * 1000) / 10 : null,
      }))
      .sort((a, b) => b.count - a.count),
    total_messages: totalMessages,
    distinct_languages: distinctLanguages,
    post_op_due: postOpDue,
    post_op_sent: postOpSent,
    follow_up_rate: followUpRate,
    night_messages: nightMessages,
    night_replied: nightReplied,
    night_coverage_rate: nightCoverageRate,
  };
}
