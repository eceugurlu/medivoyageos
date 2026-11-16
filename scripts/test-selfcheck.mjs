// Ücretsiz Uyum Kontrolü — beyana dayalı skor. DB yok, ağ yok.
// Run: npm run check:selfcheck
import {
  selfAssess, DOC_QUESTIONS, PRACTICE_QUESTIONS, ALL_QUESTION_IDS,
  ACCREDITATION_DEADLINE, COMPLICATION_INSURANCE_DEADLINE,
} from '../src/services/complianceSelfCheck.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
const NOW = '2026-10-28T10:00:00.000Z';
const item = (r, id) => r.items.find((i) => i.id === id);
const allValid = {
  health_tourism_authorization: 'valid', accreditation: 'valid', accreditation_valid_until: '2028-01-01',
  complication_insurance: 'valid', complication_insurance_valid_until: '2027-06-01', kvkk_registry: 'valid',
  foreign_language_staff: 'valid', contact_logs: 'always', consent_records: 'always',
  postop_followup: 'always', outcome_records: 'always',
};

console.log('▶ Boş anket: 0 puan DEĞİL');
{
  const r = selfAssess({}, { now: NOW });
  check('skor null', r.score === null, r.score);
  check('kapsam 0', r.coverage === 0);
  check('cevaplanan 0', r.answered === 0);
  check('her madde unknown', r.items.every((i) => i.status === 'unknown'));
  check('hiçbir maddede score 0 yok', r.items.every((i) => i.score !== 0));
  check('tüm maddeler açık listesinde', r.gaps.length === r.question_count);
  check('belge maddeleri declared=false', item(r, 'accreditation').declared === false);
}

console.log('\n▶ Her şey sonuç: ölçüm DEĞİL, beyan');
{
  const r = selfAssess(allValid, { now: NOW });
  check('declared_only bayrağı var', r.declared_only === true);
  check('hiçbir madde measured değil', r.items.every((i) => i.measured === false));
  check('tam cevapta skor 100', r.score === 100, r.score);
  check('kapsam 1', r.coverage === 1);
  check('açık kalmaz', r.gaps.length === 0);
}

console.log('\n▶ Belge cevapları');
{
  const miss = selfAssess({ ...allValid, accreditation: 'missing' }, { now: NOW });
  check('yok → fail, 0 puan', item(miss, 'accreditation').status === 'fail' && item(miss, 'accreditation').score === 0);
  check('yok cevabı da bir CEVAPTIR (kapsama girer)', miss.coverage === 1, miss.coverage);
  check('skor düştü', miss.score < 100 && miss.score > 0, miss.score);

  const prog = selfAssess({ ...allValid, accreditation: 'in_progress' }, { now: NOW });
  check('süreçte → warn, 0.5', item(prog, 'accreditation').status === 'warn' && item(prog, 'accreditation').score === 0.5);

  const expired = selfAssess({ ...allValid, accreditation_valid_until: '2026-01-01' }, { now: NOW });
  check('süresi dolmuş belge → fail', item(expired, 'accreditation').status === 'fail', item(expired, 'accreditation'));
  check('kaç gün önce dolduğu yazılı', /gün önce dolmuş/.test(item(expired, 'accreditation').evidence));

  const soon = selfAssess({ ...allValid, complication_insurance_valid_until: '2026-11-20' }, { now: NOW });
  check('yakında dolan belge → warn', item(soon, 'complication_insurance').status === 'warn');
  check('kalan gün raporlanıyor', item(soon, 'complication_insurance').expires_in_days === 23,
    item(soon, 'complication_insurance').expires_in_days);

  const junk = selfAssess({ ...allValid, accreditation_valid_until: 'yakında' }, { now: NOW });
  check('bozuk tarih yok sayılır, patlamaz', item(junk, 'accreditation').status === 'ok');
  const badAnswer = selfAssess({ ...allValid, accreditation: 'belki' }, { now: NOW });
  check('tanınmayan cevap unknown olur', item(badAnswer, 'accreditation').status === 'unknown');
  check('tanınmayan cevap kapsamı düşürür', badAnswer.coverage < 1);
}

console.log('\n▶ Uygulama soruları: "çoğu zaman" tam puan almaz');
{
  const mostly = selfAssess({ ...allValid, consent_records: 'mostly' }, { now: NOW });
  const it = item(mostly, 'consent_records');
  check("'çoğu zaman' 0.6", it.score === 0.6, it.score);
  check('warn statüsü', it.status === 'warn');
  // Yönetmelik "çoğunlukla açık rıza aldık" demeyi kabul etmiyor; sonuç
  // metninin bunu söylemesi, skorun kendisi kadar önemli.
  check('metni denetimde eksik sayılacağını söylüyor', /denetimde eksik/.test(it.evidence), it.evidence);

  const sometimes = selfAssess({ ...allValid, consent_records: 'sometimes' }, { now: NOW });
  check("'bazen' 0.3 ve fail", item(sometimes, 'consent_records').score === 0.3
    && item(sometimes, 'consent_records').status === 'fail');
  const never = selfAssess({ ...allValid, consent_records: 'never' }, { now: NOW });
  check("'hiç' 0 puan", item(never, 'consent_records').score === 0);
  check("'hiç' açık listesinde", never.gaps.some((g) => g.id === 'consent_records'));
}

console.log('\n▶ Kısmi anket: skor yüksek çıkabilir ama kapsam söyler');
{
  // Yalnızca kolay soruları cevaplayan bir klinik 100 alır. O yüzden
  // kapsamın skorla birlikte raporlanması zorunlu.
  const partial = selfAssess({ kvkk_registry: 'valid' }, { now: NOW });
  check('tek cevapla skor 100 olabilir', partial.score === 100);
  check('ama kapsam çok düşük', partial.coverage > 0 && partial.coverage < 0.1, partial.coverage);
  check('cevaplanan sayısı raporlanıyor', partial.answered === 1);
  check('kalan açıklar listede', partial.gaps.length === partial.question_count - 1);
}

console.log('\n▶ Son tarihler compliance.js ile aynı kaynaktan');
{
  const r = selfAssess(allValid, { now: NOW });
  check('akreditasyon son tarihi 31.12.2026', ACCREDITATION_DEADLINE === '2026-12-31');
  check('komplikasyon sigortası geçiş süresi son tarihi 31.12.2025 (Geçici Madde 1/2)',
    COMPLICATION_INSURANCE_DEADLINE === '2025-12-31');
  check('kalan gün hesaplandı (64)', r.deadlines.accreditation_days === 64, r.deadlines);
  check('akreditasyon maddesi geri sayım taşır', item(r, 'accreditation').deadline_days === 64);
  // 16.11.2026 düzeltmesi: bu artık geri sayımsız bir rozet değil, gerçek
  // bir deadline — 28.10.2026'ya göre 31.12.2025 ÇOKTAN GEÇMİŞ (negatif).
  check('sigorta maddesi deadline_days taşır (negatif, süresi çoktan geçmiş)',
    item(r, 'complication_insurance').deadline_days < 0, item(r, 'complication_insurance').deadline_days);
  check('sigorta in_force_since alanını da taşır (bilgi amaçlı)',
    item(r, 'complication_insurance').in_force_since === COMPLICATION_INSURANCE_DEADLINE);
}

console.log('\n▶ Soru listesi ve ağırlıklar');
{
  check('9 soru var', ALL_QUESTION_IDS.length === 9, ALL_QUESTION_IDS.length);
  check('soru kimlikleri tekil', new Set(ALL_QUESTION_IDS).size === ALL_QUESTION_IDS.length);
  const total = [...DOC_QUESTIONS, ...PRACTICE_QUESTIONS].reduce((s, q) => s + q.weight, 0);
  check('toplam ağırlık 21', total === 21, total);
  check('sonuç kaydı en ağır tek madde',
    PRACTICE_QUESTIONS.find((q) => q.id === 'outcome_records').weight === 3);
}

console.log('\n▶ Dayanıklılık');
{
  for (const bad of [undefined, null, 'metin', 42, [], { accreditation: null }, { now: 'çöp' }]) {
    let ok = true;
    try { selfAssess(bad, { now: NOW }); } catch { ok = false; }
    check(`girdi ${JSON.stringify(bad)} → hata yok`, ok);
  }
  let ok = true;
  try { selfAssess(allValid, { now: 'çöp' }); } catch { ok = false; }
  check('geçersiz now → bugüne düşer, patlamaz', ok);
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
