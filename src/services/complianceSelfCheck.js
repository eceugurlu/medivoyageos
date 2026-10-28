// Ücretsiz Uyum Kontrolü — beyana dayalı öz değerlendirme.
//
// Panel içindeki Risk & Uyum skoru kliniğin KENDİ VERİSİNDEN ölçülür
// (services/compliance.js). Bu modül onun kamuya açık, beyana dayalı
// kardeşi: klinik 10 soruya cevap verir, aynı ağırlık ve kapsam mantığıyla
// puanlanır — ama hiçbir şey ölçülmemiştir, yalnızca söylenmiştir.
//
// İkisini ayrı modüller olarak tutmamın nedeni tam bu: aynı fonksiyona
// "ölçülmüş" ve "beyan edilmiş" girdiyi birlikte kabul ettirmek, zamanla
// birinin diğerine karışmasıyla biter. Son tarihler ve eşikler ise
// compliance.js'ten içe aktarılıyor; yönetmelik değişirse tek yerden değişir.

import { ACCREDITATION_DEADLINE, INSURANCE_MANDATORY_SINCE, daysUntil, EXPIRY_WARNING_DAYS } from './compliance.js';

export { ACCREDITATION_DEADLINE, INSURANCE_MANDATORY_SINCE };

// Belge soruları: klinik ne diyor?
export const DOC_ANSWERS = ['valid', 'in_progress', 'missing'];
// Uygulama soruları: ne sıklıkla yapılıyor?
export const PRACTICE_ANSWERS = ['always', 'mostly', 'sometimes', 'never'];

// Sıklık → puan. 'mostly' 0.6, 'sometimes' 0.3: yönetmelik "çoğunlukla"
// kabul etmiyor, o yüzden "çoğu zaman" tam puan almıyor.
const PRACTICE_SCORE = { always: 1, mostly: 0.6, sometimes: 0.3, never: 0 };

export const DOC_QUESTIONS = [
  { id: 'health_tourism_authorization', weight: 3, label: 'Sağlık turizmi yetki belgesi' },
  { id: 'accreditation', weight: 3, label: 'Akreditasyon belgesi', deadline: ACCREDITATION_DEADLINE },
  { id: 'complication_insurance', weight: 3, label: 'Komplikasyon sigortası', inForceSince: INSURANCE_MANDATORY_SINCE },
  { id: 'kvkk_registry', weight: 1, label: 'KVKK / VERBİS kaydı' },
];

export const PRACTICE_QUESTIONS = [
  { id: 'multilingual_24_7', weight: 2, label: '7/24 çok dilli erişim' },
  { id: 'contact_logs', weight: 2, label: 'Hasta iletişim kayıtları' },
  { id: 'consent_records', weight: 2, label: 'Açık rıza kaydı' },
  { id: 'postop_followup', weight: 2, label: 'Ameliyat sonrası takip' },
  { id: 'outcome_records', weight: 3, label: 'Ameliyat sonucu kaydı' },
];

function statusFromScore(score) {
  if (score == null) return 'unknown';
  if (score >= 0.9) return 'ok';
  if (score >= 0.6) return 'warn';
  return 'fail';
}

function isoDate(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

function docItem(q, answer, validUntil, now) {
  const deadlineDays = q.deadline ? daysUntil(q.deadline, now) : null;
  const base = {
    id: q.id, label: q.label, weight: q.weight, required: true, group: 'documents',
    deadline_days: deadlineDays, in_force_since: q.inForceSince || null,
    declared: true, measured: false,
  };
  if (!DOC_ANSWERS.includes(answer)) {
    return { ...base, declared: false, status: 'unknown', score: null, evidence: 'Cevaplanmadı — skora dahil edilmedi.' };
  }
  if (answer === 'missing') {
    return { ...base, status: 'fail', score: 0, evidence: 'Yok. Yönetmelik bunu zorunlu tutuyor.' };
  }
  if (answer === 'in_progress') {
    return { ...base, status: 'warn', score: 0.5, evidence: 'Başvuru sürecinde.' };
  }
  const expiresIn = daysUntil(isoDate(validUntil), now);
  if (expiresIn != null && expiresIn < 0) {
    return { ...base, status: 'fail', score: 0, expires_in_days: expiresIn,
      evidence: `Belge var ama süresi ${Math.abs(expiresIn)} gün önce dolmuş.` };
  }
  if (expiresIn != null && expiresIn <= EXPIRY_WARNING_DAYS) {
    return { ...base, status: 'warn', score: 0.6, expires_in_days: expiresIn,
      evidence: `Geçerli, ama ${expiresIn} gün içinde doluyor. Yenileme süresi gerekir.` };
  }
  return { ...base, status: 'ok', score: 1, expires_in_days: expiresIn, evidence: 'Geçerli (beyan).' };
}

function practiceItem(q, answer) {
  const base = { id: q.id, label: q.label, weight: q.weight, required: true, group: 'practice',
    declared: PRACTICE_ANSWERS.includes(answer), measured: false, deadline_days: null, in_force_since: null };
  if (!PRACTICE_ANSWERS.includes(answer)) {
    return { ...base, status: 'unknown', score: null, evidence: 'Cevaplanmadı — skora dahil edilmedi.' };
  }
  const score = PRACTICE_SCORE[answer];
  const text = {
    always: 'Her zaman yapılıyor (beyan).',
    mostly: 'Çoğu zaman yapılıyor. Yönetmelik "çoğu zaman"ı kabul etmiyor; denetimde eksik sayılır.',
    sometimes: 'Bazen yapılıyor. Denetimde kanıtlanamaz.',
    never: 'Yapılmıyor. Yönetmelik bunu zorunlu tutuyor.',
  }[answer];
  return { ...base, status: statusFromScore(score), score, evidence: text };
}

/**
 * @param {object} answers { [questionId]: 'valid'|'always'|… , accreditation_valid_until: 'YYYY-MM-DD', … }
 * @param {{now?: Date|string}} opts
 */
export function selfAssess(answers = {}, opts = {}) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const parsed = opts.now ? new Date(opts.now) : new Date();
  const now = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  const items = [
    ...DOC_QUESTIONS.map((q) => docItem(q, a[q.id], a[`${q.id}_valid_until`], now)),
    ...PRACTICE_QUESTIONS.map((q) => practiceItem(q, a[q.id])),
  ];

  // Toplama kuralı compliance.js ile aynı: puanlanamayan madde skora
  // GİRMEZ, kapsamı düşürür. Boş bırakılan bir anket 0/100 değil,
  // "henüz ölçülmedi"dir.
  const scored = items.filter((i) => i.score != null);
  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  const scoredWeight = scored.reduce((s, i) => s + i.weight, 0);
  const score = scoredWeight
    ? Math.round((scored.reduce((s, i) => s + i.score * i.weight, 0) / scoredWeight) * 100)
    : null;

  const gaps = items
    .filter((i) => i.status === 'fail' || i.status === 'unknown')
    .map((i) => ({ id: i.id, label: i.label, status: i.status, deadline_days: i.deadline_days }));

  return {
    computed_at: now.toISOString(),
    declared_only: true, // her tüketici bunu görsün: ölçüm değil, beyan
    score,
    coverage: totalWeight ? Math.round((scoredWeight / totalWeight) * 1000) / 1000 : 0,
    answered: scored.length,
    question_count: items.length,
    items,
    gaps,
    deadlines: {
      accreditation_days: daysUntil(ACCREDITATION_DEADLINE, now),
      insurance_mandatory_since: INSURANCE_MANDATORY_SINCE,
    },
  };
}

export const ALL_QUESTION_IDS = [...DOC_QUESTIONS, ...PRACTICE_QUESTIONS].map((q) => q.id);
