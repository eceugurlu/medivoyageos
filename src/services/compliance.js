// Klinik Risk & Uyum Skoru — saf hesap motoru.
//
// Girdinin tamamı repository'den gelir (bkz. getComplianceSnapshot); burada
// hiç DB, hiç ağ yok, böylece skor mantığı gerçek veri olmadan test edilebilir.
//
// Tasarımın tek kuralı: VERİ YOKSA SKOR YOK.
// Bir maddeyi puanlayacak veri yoksa score === null olur ve madde toplam
// skorun DIŞINDA kalır — 0 puan sayılmaz. 0 puan "ölçtüm, kötü" demektir;
// null "ölçemedim" demektir. İkisini karıştıran bir skor, jüriye de
// sigortacıya da yalan söyler. Bunun bedeli, skorun yanında her zaman
// "kapsam" (coverage) oranını taşımak zorunda olmamızdır: skor 92 ama kapsam
// %30 ise, skor 92 değildir — henüz yoktur.
//
// Yasal dayanak: Uluslararası Sağlık Turizmi ve Turistin Sağlığı Hakkında
// Yönetmelik (26.04.2025 tarihli, RG 32882). Aşağıdaki madde numaraları ve
// alıntılar, Resmî Gazete'nin kendi metninden (16.11.2026'da PDF'in içerik
// akışları çözülerek) BİREBİR doğrulandı — ikincil kaynaktan aktarılmadı.
//
// Her madde için SAĞLIK TESİSİ (klinik) mi, ARACI KURULUŞ (acente) mi
// muhatap olduğu AYRI AYRI doğrulandı, çünkü bu ikisi karıştırılırsa skor
// kliniğe ait olmayan bir yükümlülüğü klinik üstünden puanlar:
//
//   GEÇİCİ MADDE 1/3: "Sağlık tesisi, 6 ncı maddenin birinci fıkrasının
//   (b) bendinde yer alan yükümlülüğü 31/12/2026 tarihine kadar sağlar."
//   → Madde 6/1-b = akreditasyon/sertifika. SAĞLIK TESİSİNE ait.
//
//   GEÇİCİ MADDE 1/2: "Sağlık tesisi, 6 ncı maddenin birinci fıkrasının
//   (c) bendinde yer alan yükümlülükleri 31/12/2025 tarihine kadar sağlar."
//   → Madde 6/1-c = komplikasyon sigortası. SAĞLIK TESİSİNE ait. Bugünün
//   tarihine göre bu geçiş süresi ÇOKTAN DOLDU — yani artık geri sayım
//   değil, geçmişte kalmış ve aşılmış bir son tarih.
//
//   MADDE 7/2: "Uluslararası sağlık turizmi biriminde çalışan personelin
//   en az birinin yabancı dil bilmesi ve bunun belgelendirilmesi
//   zorunludur." → SAĞLIK TESİSİNE ait. Bu, "7/24 iki dilde çağrı merkezi"
//   DEĞİLDİR — o ayrı ve daha ağır bir yükümlülük (hemen altına bakın).
//
//   MADDE 6/2-b: "Aracı kuruluş, gelen çağrıları karşılamak amacıyla en az
//   iki yabancı dilde ve 7 gün 24 saat esasına uygun olarak hizmet
//   verebilecek bir alt yapıya sahip olmak ya da bu alt yapıyı
//   sağlayabilecek bir çağrı merkezi ile hizmet alımı sözleşmesi yapmak
//   zorundadır." → ARACI KURULUŞA (acente) aittir, SAĞLIK TESİSİNE DEĞİL.
//   Bu modül yalnızca klinik (sağlık tesisi) skoru ürettiği için bu madde
//   BİLEREK burada YOK — bir acente profili eklenirse oraya taşınmalı.
//
// Önceki sürümde "7/24 çok dilli erişim" kliniğe ait bir madde olarak
// gösteriliyordu; bu YANLIŞ ATIFTI ve kaldırıldı (bkz. foreign_language_staff).
export const ACCREDITATION_DEADLINE = '2026-12-31';
export const COMPLICATION_INSURANCE_DEADLINE = '2025-12-31';

// Belgenin süresi bu kadar gün içinde doluyorsa "uyarı" — yenileme süresi
// gerekir, dolduğu gün öğrenmek çok geç.
export const EXPIRY_WARNING_DAYS = 45;

// Örneklem tabanları. Klinik (komplikasyon) oranı için yüksek, süreç
// (kayıt tutma, takip) oranları için düşük: biri hasta sonucu hakkında
// iddiada bulunur, diğeri sadece kliniğin kendi disiplinini ölçer.
export const MIN_CLINICAL_SAMPLE = 20;
export const MIN_PROCESS_SAMPLE = 5;
export const MIN_CALL_SAMPLE = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bir tarihe kalan gün (geçmişse negatif). Geçersiz/boş girdide null. */
export function daysUntil(date, now = new Date()) {
  if (!date) return null;
  const target = date instanceof Date ? date : new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;
  const ref = toDate(now);
  const today = new Date(`${ref.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((target.getTime() - today.getTime()) / DAY_MS);
}

/**
 * Tarihe çevirir; çevrilemiyorsa BUGÜNE düşer, atmaz.
 * Bu bir kozmetik koruma değil: `now` geçersiz geldiğinde toISOString()
 * RangeError atıyordu ve skor ekranının tamamı 500 oluyordu. Skor,
 * hesaplayamadığı bir maddeyi atlamayı bilmeli — çökmemeli.
 */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date() : value;
  if (value == null) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Doğrusal bant. value `good`e ulaşınca 1, `bad`e inince 0, arada doğrusal.
 * good < bad verildiğinde yön kendiliğinden tersine döner (düşük = iyi).
 */
export function band(value, good, bad) {
  if (value == null || !Number.isFinite(value)) return null;
  if (good === bad) return value >= good ? 1 : 0;
  const t = (value - bad) / (good - bad);
  return Math.max(0, Math.min(1, t));
}

function statusFromScore(score) {
  if (score == null) return 'unknown';
  if (score >= 0.9) return 'ok';
  if (score >= 0.6) return 'warn';
  return 'fail';
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

const pct = (r) => (r == null ? null : Math.round(r * 1000) / 10);

// ── Belge maddeleri ────────────────────────────────────────────────────────
// Klinik beyanı. verified_at boşsa doğrulanmamıştır ve bunu saklamıyoruz:
// madde `declared: true, verified: false` taşır, panel de öyle gösterir.
// `deadline` ve `inForceSince` BİRLİKTE verilebilir (komplikasyon sigortası
// gibi): deadline geri sayımı/rozeti besler (panelde deadline_days varsa o
// öncelik alır), in_force_since yalnızca deadline hiç verilmemişse fallback
// olarak "zaten zorunlu" rozetini gösterir. Akreditasyon gibi yalnızca
// gelecekteki bir maddede sadece `deadline` yeterli.
function documentItem({ id, label, weight, required, record, now, deadline, inForceSince }) {
  const deadlineDays = deadline ? daysUntil(deadline, now) : null;
  const base = {
    id, group: 'compliance', label, weight, required,
    deadline_days: deadlineDays,
    in_force_since: inForceSince || null,
  };

  if (!record || record.status === 'missing') {
    return {
      ...base,
      status: 'unknown',
      score: null,
      declared: false,
      verified: false,
      evidence: 'Belge bilgisi girilmemiş — skora dahil edilmedi.',
    };
  }

  const expiresIn = daysUntil(record.valid_until, now);
  const declared = true;
  const verified = Boolean(record.verified_at);
  const issuer = record.issuer ? ` · ${record.issuer}` : '';

  if (record.status === 'expired' || (expiresIn != null && expiresIn < 0)) {
    return {
      ...base,
      status: 'fail',
      score: 0,
      declared,
      verified,
      expires_in_days: expiresIn,
      evidence: `Süresi ${expiresIn == null ? '' : `${Math.abs(expiresIn)} gün önce `}doldu${issuer}.`,
    };
  }
  if (record.status === 'in_progress') {
    return {
      ...base,
      status: 'warn',
      score: 0.5,
      declared,
      verified,
      expires_in_days: expiresIn,
      evidence: `Başvuru sürecinde${issuer}.`,
    };
  }
  if (record.status === 'valid' && expiresIn != null && expiresIn <= EXPIRY_WARNING_DAYS) {
    return {
      ...base,
      status: 'warn',
      score: 0.6,
      declared,
      verified,
      expires_in_days: expiresIn,
      evidence: `Geçerli ama ${expiresIn} gün içinde doluyor${issuer}.`,
    };
  }
  return {
    ...base,
    status: 'ok',
    score: 1,
    declared,
    verified,
    expires_in_days: expiresIn,
    evidence: verified
      ? `Geçerli ve doğrulandı${issuer}.`
      : `Geçerli — klinik beyanı, doğrulanmadı${issuer}.`,
  };
}

// ── Ölçüm maddeleri ───────────────────────────────────────────────────────
function measuredItem({ id, group, label, weight, required = false, value, unit, sample, minSample, good, bad, evidenceOk, evidenceThin }) {
  const base = { id, group, label, weight, required, value, unit, sample };
  if (sample < minSample) {
    return {
      ...base,
      status: 'unknown',
      score: null,
      // value da null. Örneklem altında hesaplanmış oranı taşımak zararsız
      // görünür ama değil: panel onu büyük puntoyla basıp yanına "veri yok"
      // yazıyordu — 4 takip görevinin 4'ü tamamsa ekranda "%100 / veri yok"
      // çıkıyordu. Arkasında duramadığımız sayıyı hiç göndermemek, her
      // tüketiciyi (panel, rapor, ileride API müşterisi) aynı dürüstlüğe
      // mecbur bırakır. Sayılar evidence satırında yazılı, kaybolmuyor.
      value: null,
      evidence: evidenceThin || `Örneklem yetersiz (${sample} < ${minSample}) — skora dahil edilmedi.`,
    };
  }
  const score = band(value, good, bad);
  return { ...base, status: statusFromScore(score), score, evidence: evidenceOk };
}

/**
 * Snapshot → skor. Girdi tamamen opsiyonel alanlardan oluşur; eksik her alan
 * ilgili maddeyi 'unknown' yapar, hesabı patlatmaz.
 */
export function computeComplianceScore(input = {}) {
  const now = toDate(input.now);
  const byKind = new Map((input.records || []).map((r) => [r.kind, r]));
  const consent = input.consent || {};
  const outcomes = input.outcomes || {};
  const postop = input.postop || {};
  const response = input.response || {};

  const items = [];

  // ── UYUM: belgeler ──
  items.push(documentItem({
    id: 'health_tourism_authorization',
    label: 'Sağlık turizmi yetki belgesi',
    weight: 3, required: true, record: byKind.get('health_tourism_authorization'), now,
  }));
  items.push(documentItem({
    id: 'accreditation',
    label: 'Akreditasyon',
    weight: 3, required: true, record: byKind.get('accreditation'), now,
    deadline: ACCREDITATION_DEADLINE,
  }));
  items.push(documentItem({
    id: 'complication_insurance',
    label: 'Komplikasyon sigortası',
    weight: 3, required: true, record: byKind.get('complication_insurance'), now,
    // Geçici Madde 1/2'nin kendisi bir SON TARİH (31.12.2025), "yürürlüğe
    // giriş" değil — önceki sürüm bunu `inForceSince` (geri sayımsız,
    // sabit bir rozet) olarak modelliyordu, bu YANLIŞTI. Artık akreditasyon
    // gibi gerçek bir deadline: bugünün tarihine göre bu süre ÇOKTAN DOLDU,
    // yani deadline_days negatif çıkıyor — "süresi geçti" burada doğru bir
    // ifade, çünkü geçiş süresi gerçekten geçti.
    deadline: COMPLICATION_INSURANCE_DEADLINE,
    inForceSince: COMPLICATION_INSURANCE_DEADLINE,
  }));
  items.push(documentItem({
    id: 'kvkk_registry',
    label: 'VERBİS kaydı',
    weight: 1, required: true, record: byKind.get('kvkk_registry'), now,
  }));
  // Madde 7/2'nin birebir karşılığı: "Uluslararası sağlık turizmi biriminde
  // çalışan personelin en az birinin yabancı dil bilmesi ve bunun
  // belgelendirilmesi zorunludur." — SAĞLIK TESİSİNE ait, önceki sürümdeki
  // "7/24 çok dilli erişim" maddesinin YANLIŞ atfedilmiş hâlinin yerini alır
  // (o madde aslında Madde 6/2-b ile ARACI KURULUŞA ait, bkz. dosya başı).
  items.push(documentItem({
    id: 'foreign_language_staff',
    label: 'Personel yabancı dil belgesi',
    weight: 2, required: true, record: byKind.get('foreign_language_staff'), now,
  }));

  // ── UYUM: ölçümler ──
  const consentTotal = Number(consent.total || 0);
  const consentRate = ratio(Number(consent.granted || 0), consentTotal);
  items.push(measuredItem({
    id: 'kvkk_consent_rate', group: 'compliance',
    label: 'Açık rıza oranı',
    weight: 2, required: true,
    value: consentRate, unit: 'rate', sample: consentTotal, minSample: MIN_PROCESS_SAMPLE,
    good: 0.98, bad: 0.75,
    evidenceOk: `${consent.granted || 0}/${consentTotal} hastada açık rıza kayıtlı (%${pct(consentRate)}).`,
  }));

  // "Çağrı kaydı bütünlüğü" ve "7/24 çok dilli erişim" maddeleri buradan
  // KALDIRILDI (16.11.2026 denetiminde):
  //   - "7/24 çok dilli erişim" Madde 6/2-b'ye dayandırılmıştı ama o madde
  //     ARACI KURULUŞA aittir, sağlık tesisine (klinik) değil — yanlış atıf.
  //   - "Çağrı kaydı bütünlüğü"ndeki "yönetmeliğin istediği üç alan" (zaman
  //     + arayan + sonuç) iddiasının yönetmelik metninde karşılığı
  //     doğrulanamadı; böyle bir madde bulunamadı. Kesin hukuki referans
  //     olmadan bir maddeyi yönetmeliğe dayandırmak yanıltıcı olurdu.
  // Her ikisi de zaten `calls` tablosuna (sesli AI) bağlıydı ve telefon
  // hattı henüz canlı değil — kaldırılmaları bugün hiçbir ölçülen veriyi
  // kaybetmiyor.

  // ── RİSK: sonuç verisi ──
  const operated = Number(outcomes.operated || 0);
  const recorded = Number(outcomes.recorded || 0);
  const recordRate = ratio(recorded, operated);
  items.push(measuredItem({
    id: 'outcome_recording_rate', group: 'risk',
    label: 'Sonuç kayıt oranı',
    weight: 3,
    value: recordRate, unit: 'rate', sample: operated, minSample: MIN_PROCESS_SAMPLE,
    good: 0.9, bad: 0.4,
    evidenceOk: `Ameliyat edilen ${operated} hastanın ${recorded}'inde sonuç kayıtlı (%${pct(recordRate)}). Aşağıdaki komplikasyon oranı yalnızca bu kadarını görüyor.`,
    evidenceThin: `Ameliyat kaydı ${operated} — sonuç oranı için çok az (< ${MIN_PROCESS_SAMPLE}).`,
  }));

  // Komplikasyon oranı KASITLI olarak puanlanmaz (weight 0, score null).
  // Puanlamak için sektör kıyaslaması gerekir; Türkiye sağlık turizminde
  // yayınlanmış klinik bazlı komplikasyon oranı YOK (arandı, bulunamadı) —
  // kendi uydurduğumuz bir eşik, iyi bir kliniği kötü gösterebilirdi.
  // O yüzden ölçüyoruz, not vermiyoruz. Eksik olan kıyaslamayı zaten bu veri
  // üretecek. Statüsü ayrı: 'measured'.
  const complications = Number(outcomes.complications || 0);
  const revisions = Number(outcomes.revisions || 0);
  const complicationRate = recorded >= MIN_CLINICAL_SAMPLE
    ? ratio(complications + revisions, recorded)
    : null;
  items.push({
    id: 'complication_rate', group: 'risk',
    label: 'Komplikasyon + revizyon oranı',
    weight: 0, required: false,
    status: complicationRate == null ? 'unknown' : 'measured',
    score: null,
    value: complicationRate, unit: 'rate', sample: recorded,
    evidence: complicationRate == null
      ? `Sonuç kaydı ${recorded} — klinik oran için yetersiz (< ${MIN_CLINICAL_SAMPLE}). Bu sayı az örneklemde yanıltıcıdır, o yüzden gösterilmiyor.`
      : `${complications} komplikasyon + ${revisions} revizyon / ${recorded} kayıtlı sonuç (%${pct(complicationRate)}). Puanlanmadı: yayınlanmış sektör kıyaslaması yok — ölçülen değer, not değil.`,
  });

  const postopResolved = Number(postop.completed || 0) + Number(postop.overdue || 0);
  const postopRate = ratio(Number(postop.completed || 0), postopResolved);
  items.push(measuredItem({
    id: 'postop_followup_compliance', group: 'risk',
    label: 'Ameliyat sonrası takip uyumu',
    weight: 2,
    value: postopRate, unit: 'rate', sample: postopResolved, minSample: MIN_PROCESS_SAMPLE,
    good: 0.95, bad: 0.6,
    evidenceOk: `Vadesi gelen ${postopResolved} takip görevinin ${postop.completed || 0}'i tamamlandı (%${pct(postopRate)}); ${postop.overdue || 0} gecikti.`,
    evidenceThin: `Vadesi gelmiş takip görevi ${postopResolved} — oran için çok az (< ${MIN_PROCESS_SAMPLE}).`,
  }));

  // NOT: bunu conversations.escalated_at üzerinden ölçemiyoruz.
  // setConversationStatus() devralmada escalated_at'i NULL'a çekiyor (SLA
  // saatini sıfırlamak için, doğru karar) — yani devrin ne kadar sürdüğünün
  // kanıtı tam o anda siliniyor. O yüzden ölçtüğümüz şeyi gerçekte
  // ölçtüğümüz şey olarak adlandırıyoruz: hastanın mesajından insanın
  // cevabına kadar geçen süre. Mevcut veriden türetilebilen, uydurma
  // olmayan rakam bu.
  const humanSamples = Number(response.human_samples || 0);
  const humanMedian = response.human_median_minutes == null ? null : Number(response.human_median_minutes);
  items.push(measuredItem({
    id: 'human_response_time', group: 'risk',
    label: 'İnsan cevap süresi (medyan)',
    weight: 1,
    value: humanMedian, unit: 'minutes', sample: humanSamples, minSample: MIN_PROCESS_SAMPLE,
    good: 15, bad: 240,
    evidenceOk: `${humanSamples} turda koordinatör medyan ${humanMedian} dakikada cevapladı.`,
    evidenceThin: `İnsan cevabı olan tur sayısı ${humanSamples} — medyan için çok az (< ${MIN_PROCESS_SAMPLE}).`,
  }));

  // AI cevap süresi KASITLI olarak puanlanmaz (weight 0). Yönetmelikte bir
  // saniye eşiği yok ve sektörde yayınlanmış ortalama cevap süresi de yok —
  // yani not verecek bir cetvel yok. Ama bu rakam ürünün farkının TA KENDİSİ,
  // o yüzden ölçülür ve ekranda başlık olur. Kanıt kendi verimizden gelir,
  // iddiadan değil.
  const aiSamples = Number(response.ai_samples || 0);
  const aiMedian = response.ai_median_seconds == null ? null : Number(response.ai_median_seconds);
  const unknownTurns = Number(response.unknown_samples || 0);
  items.push({
    id: 'ai_response_time', group: 'risk',
    label: 'AI cevap süresi (medyan)',
    weight: 0, required: false,
    status: aiSamples < MIN_PROCESS_SAMPLE ? 'unknown' : 'measured',
    score: null,
    value: aiMedian, unit: 'seconds', sample: aiSamples,
    evidence: aiSamples < MIN_PROCESS_SAMPLE
      ? `AI cevabı olan tur sayısı ${aiSamples} — medyan için çok az (< ${MIN_PROCESS_SAMPLE}).`
      : `${aiSamples} turda medyan ${aiMedian} saniye.${unknownTurns ? ` ${unknownTurns} turun kaynağı (AI/insan) kayıtlı değil, hesaba katılmadı.` : ''} Puanlanmadı: yönetmelikte süre eşiği, sektörde yayınlanmış ortalama yok.`,
  });

  // ── Toplama ──
  const summarize = (subset) => {
    const weighted = subset.filter((i) => i.score != null && i.weight > 0);
    const totalWeight = subset.reduce((s, i) => s + i.weight, 0);
    const scoredWeight = weighted.reduce((s, i) => s + i.weight, 0);
    if (!scoredWeight) return { score: null, coverage: 0, scored_weight: 0, total_weight: totalWeight };
    const score = weighted.reduce((s, i) => s + i.score * i.weight, 0) / scoredWeight;
    return {
      score: Math.round(score * 100),
      coverage: totalWeight ? Math.round((scoredWeight / totalWeight) * 100) / 100 : 0,
      scored_weight: scoredWeight,
      total_weight: totalWeight,
    };
  };

  const compliance = summarize(items.filter((i) => i.group === 'compliance'));
  const risk = summarize(items.filter((i) => i.group === 'risk'));
  const overall = summarize(items);

  // Kapatılması gereken açıklar: yasal zorunlu olup ya başarısız ya da hiç
  // veri girilmemiş maddeler. "unknown" da buraya girer — jüriye de klinik
  // sahibine de "bilmiyoruz" ile "tamam" aynı şey değildir.
  const gaps = items
    .filter((i) => i.required && (i.status === 'fail' || i.status === 'unknown'))
    .map((i) => ({
      id: i.id, label: i.label, status: i.status,
      deadline_days: i.deadline_days, in_force_since: i.in_force_since || null,
    }));

  return {
    computed_at: now.toISOString(),
    score: overall.score,
    coverage: overall.coverage,
    groups: { compliance, risk },
    items,
    gaps,
    deadlines: {
      accreditation_days: daysUntil(ACCREDITATION_DEADLINE, now),
      complication_insurance_deadline: COMPLICATION_INSURANCE_DEADLINE,
      complication_insurance_days: daysUntil(COMPLICATION_INSURANCE_DEADLINE, now),
    },
    // Kullanıcı talebi (16.11.2026): bu motor bir hukuki değerlendirme
    // üretmiyor, yalnızca kliniğin beyanını ve ölçülebilen veriyi bir araya
    // getiriyor. Skor ya da kapsam ne olursa olsun bu metin HER ZAMAN döner;
    // panel ve PDF rapor bunu olduğu gibi göstermeli.
    legal_disclaimer: 'Uyum göstergeleri, hukuki görüş değildir. Yönetmeliğe tam uyum için kendi hukuk danışmanınıza başvurun.',
  };
}

export const COMPLIANCE_KINDS = [
  'health_tourism_authorization',
  'accreditation',
  'complication_insurance',
  'kvkk_registry',
  'foreign_language_staff',
];
export const COMPLIANCE_STATUSES = ['missing', 'in_progress', 'valid', 'expired'];
export const OUTCOME_STATUSES = ['recovering', 'recovered', 'complication', 'revision_needed', 'lost_contact'];
