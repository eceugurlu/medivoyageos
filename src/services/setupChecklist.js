// 1 Günde Kurulum Kontrol Listesi — saf hesap.
//
// "Yarın başlarsınız" diyebilmek için somut bir kontrol listesi. Her adımın
// iki türden biri var:
//   auto:   gerçek veriden hesaplanır (şube var mı, WhatsApp bağlı mı).
//           Bu tabloda SATIR YOKTUR — yalan söyleyemez, yeniden hesaplanır.
//   manual: ölçülemez (ekip eğitildi mi), yalnızca elle işaretlenir.
// İkisi karıştırılmaz: panelde auto bir adım asla "işaretle" tuşu taşımaz,
// çünkü onu işaretlemek hiçbir şeyi değiştirmez — gerçek veri değişmeden
// "tamamlandı" demek yalan olurdu.

export const STEPS = [
  { key: 'clinic_profile', label: 'Klinik profili dolduruldu', category: 'kurulum', auto: true,
    hint: 'Klinik adı, diller ve iletişim bilgisi girildi.' },
  { key: 'whatsapp_connected', label: 'WhatsApp Business hattı bağlandı', category: 'kurulum', auto: true,
    hint: 'WHATSAPP_ACCESS_TOKEN ve WHATSAPP_PHONE_NUMBER_ID ayarlı.' },
  { key: 'first_branch', label: 'En az bir şube eklendi', category: 'kurulum', auto: true,
    hint: 'Tek şubeli bir klinik için bile gerekli — raporlar şubeye göre kırılır.' },
  { key: 'first_coordinator', label: 'En az bir koordinatör eklendi', category: 'ekip', auto: true,
    hint: 'Devir kuyruğunun düşeceği en az bir kişi olmalı.' },
  { key: 'payment_provider', label: 'Bir ödeme sağlayıcısı bağlandı', category: 'kurulum', auto: true,
    hint: 'Stripe veya İyzico — ikisi de boşsa ödeme linkleri yalnızca kuru-çalışma modunda çalışır.' },
  { key: 'test_conversation', label: 'Gerçek bir test mesajı gönderildi ve AI cevap verdi', category: 'doğrulama', auto: false,
    hint: "Kendi telefonunuzdan klinik numarasına yazın; AI'ın doğru dilde ve doğru tonda cevap verdiğini görün." },
  { key: 'team_trained', label: 'Ekip panel kullanımı için eğitildi', category: 'ekip', auto: false,
    hint: 'Devir alma, teklif gönderme ve ödeme linki oluşturma en az bir kez gösterildi.' },
  { key: 'escalation_tested', label: 'Acil durum devri test edildi', category: 'doğrulama', auto: false,
    hint: "\"Komplikasyon\" veya \"acil\" içeren bir test mesajı gönderip AI'ın satışı durdurup insana devrettiğini doğrulayın — bu, kliniğe söz verdiğimiz güvenlik katmanının kanıtı." },
];
export const STEP_KEYS = STEPS.map((s) => s.key);
export const AUTO_KEYS = STEPS.filter((s) => s.auto).map((s) => s.key);
export const MANUAL_KEYS = STEPS.filter((s) => !s.auto).map((s) => s.key);

/**
 * @param {Record<string, boolean>} autoSignals  { [key]: true/false } — yalnızca auto adımlar için
 * @param {Record<string, {done:boolean, done_at?:string, note?:string}>} manualState  — yalnızca manual adımlar için
 */
export function buildChecklist(autoSignals = {}, manualState = {}) {
  const items = STEPS.map((step) => {
    if (step.auto) {
      const done = Boolean(autoSignals && autoSignals[step.key]);
      return { ...step, done, done_at: null, note: null };
    }
    const m = (manualState && manualState[step.key]) || {};
    return { ...step, done: Boolean(m.done), done_at: m.done_at || null, note: m.note || null };
  });
  const done = items.filter((i) => i.done).length;
  return {
    items,
    total: items.length,
    done,
    // Bir kliniğin "kurulumu bitti" diyebilmesi için hem otomatik hem elle
    // işaretlenen her adımın tamam olması gerekir — biri eksikse genel
    // ilerleme de eksik görünmeli, "neredeyse bitti" diye yuvarlanmamalı.
    complete: done === items.length,
    progress: items.length ? Math.round((done / items.length) * 1000) / 10 : 0,
  };
}
