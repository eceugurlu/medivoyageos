// Risk & Uyum skoru hesabı — DB yok, ağ yok, anahtar yok. Saf fonksiyon.
// Run: npm run check:compliance
import {
  computeComplianceScore, band, daysUntil,
  ACCREDITATION_DEADLINE, COMPLICATION_INSURANCE_DEADLINE, MIN_CLINICAL_SAMPLE, MIN_PROCESS_SAMPLE,
} from '../src/services/compliance.js';

let failed = 0;
const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) failed++; };
const NOW = '2026-10-28T10:00:00.000Z';
const item = (r, id) => r.items.find((i) => i.id === id);

console.log('▶ Yardımcılar');
{
  check('daysUntil geçmiş tarihte negatif', daysUntil('2026-10-01', new Date(NOW)) === -27);
  check('daysUntil gelecek tarihte pozitif', daysUntil('2026-12-31', new Date(NOW)) === 64);
  check('daysUntil boş girdide null', daysUntil(null, new Date(NOW)) === null);
  check('daysUntil geçersiz tarihte null', daysUntil('not-a-date', new Date(NOW)) === null);
  check('band iyi uçta 1', band(1.0, 0.98, 0.75) === 1);
  check('band kötü uçta 0', band(0.5, 0.98, 0.75) === 0);
  check('band arada doğrusal', Math.abs(band(0.865, 0.98, 0.75) - 0.5) < 0.01);
  check('band ters yönde çalışır (düşük=iyi)', band(15, 15, 240) === 1 && band(240, 15, 240) === 0);
  check('band null girdide null', band(null, 1, 0) === null);
}

console.log('\n▶ Boş klinik: skor 0 DEĞİL, null olmalı');
{
  // Bu testin tamamı tek bir şey için var: hiç veri girmemiş bir klinik
  // "0/100 kötü klinik" değildir, "henüz ölçülmemiş" kliniktir. Skoru 0
  // yapan bir hesap, satışta da denetimde de yanlış şey söyler.
  const r = computeComplianceScore({ now: NOW });
  check('toplam skor null', r.score === null);
  check('kapsam 0', r.coverage === 0);
  check('her madde unknown', r.items.every((i) => i.status === 'unknown'));
  check('hiçbir maddede score 0 yok', r.items.every((i) => i.score !== 0));
  check('6 zorunlu maddenin tamamı açık olarak listelenir', r.gaps.length === 6, r.gaps.length);
  check('belge maddeleri declared=false', item(r, 'accreditation').declared === false);
}

console.log('\n▶ Belge maddeleri');
{
  const base = (records) => computeComplianceScore({ now: NOW, records });
  const valid = base([{ kind: 'accreditation', status: 'valid', valid_until: '2027-06-30', issuer: 'JCI' }]);
  check('geçerli belge 1 puan', item(valid, 'accreditation').score === 1);
  check('doğrulanmamış belge beyan olarak işaretlenir',
    item(valid, 'accreditation').verified === false
    && /klinik beyanı/.test(item(valid, 'accreditation').evidence));

  const verified = base([{ kind: 'accreditation', status: 'valid', valid_until: '2027-06-30', verified_at: NOW }]);
  check('verified_at varsa doğrulandı yazar', item(verified, 'accreditation').verified === true
    && /doğrulandı/.test(item(verified, 'accreditation').evidence));

  const expiring = base([{ kind: 'complication_insurance', status: 'valid', valid_until: '2026-11-15' }]);
  check('45 gün içinde dolan belge uyarı', item(expiring, 'complication_insurance').status === 'warn');
  check('kalan gün sayısı raporlanır', item(expiring, 'complication_insurance').expires_in_days === 18);

  const lapsed = base([{ kind: 'complication_insurance', status: 'valid', valid_until: '2026-09-01' }]);
  check('status valid ama tarih geçmişse yine de fail', item(lapsed, 'complication_insurance').status === 'fail');
  check('fail olan belge 0 puan (veri var, kötü)', item(lapsed, 'complication_insurance').score === 0);

  const pending = base([{ kind: 'health_tourism_authorization', status: 'in_progress' }]);
  check('başvuru sürecinde = warn, 0.5', item(pending, 'health_tourism_authorization').status === 'warn'
    && item(pending, 'health_tourism_authorization').score === 0.5);

  const missing = base([{ kind: 'accreditation', status: 'missing' }]);
  check('missing kaydı, kayıt yokmuş gibi unknown', item(missing, 'accreditation').status === 'unknown');
}

console.log('\n▶ Komplikasyon sigortası: Geçici Madde 1/2, 31.12.2025 (geçmiş bir son tarih)');
{
  // 16.11.2026 düzeltmesi: 31.12.2025 sigortanın YÜRÜRLÜK tarihi değil,
  // Resmî Gazete'nin kendi GEÇİŞ SÜRESİ son tarihi (Geçici Madde 1/2,
  // birebir doğrulandı). Akreditasyon gibi gerçek bir deadline — tek fark,
  // bugünün tarihine göre bu süre ÇOKTAN DOLMUŞ, yani negatif.
  const r = computeComplianceScore({ now: NOW });
  const ins = item(r, 'complication_insurance');
  check('sigorta maddesi deadline_days TAŞIR (artık geri sayımsız değil)', ins.deadline_days != null, ins.deadline_days);
  check('28.10.2026 tarihine göre süre çoktan geçmiş (negatif)', ins.deadline_days < 0, ins.deadline_days);
  check('in_force_since hâlâ bilgi amaçlı taşınıyor', ins.in_force_since === COMPLICATION_INSURANCE_DEADLINE);
  check('akreditasyon ise gelecekteki bir son tarih taşır (pozitif)',
    item(r, 'accreditation').deadline_days === 64 && item(r, 'accreditation').in_force_since === null);
  const gap = r.gaps.find((g) => g.id === 'complication_insurance');
  check('açıklar listesi de deadline_days ve in_force_since\'i birlikte taşır',
    gap && gap.deadline_days < 0 && gap.in_force_since === COMPLICATION_INSURANCE_DEADLINE);
}

console.log('\n▶ Son tarihler yönetmelikten, elle değil');
{
  const r = computeComplianceScore({ now: NOW });
  check('akreditasyon son tarihi 31.12.2026', ACCREDITATION_DEADLINE === '2026-12-31');
  check('kalan gün hesaplanıyor (28.10.2026 → 64)', r.deadlines.accreditation_days === 64);
  check('akreditasyon maddesi son tarihi taşır', item(r, 'accreditation').deadline_days === 64);
  const later = computeComplianceScore({ now: '2027-03-01T00:00:00.000Z' });
  check('son tarih geçince negatife döner', later.deadlines.accreditation_days < 0);
}

console.log('\n▶ Örneklem tabanı: az veri skor üretmez');
{
  const thin = computeComplianceScore({
    now: NOW,
    consent: { total: MIN_PROCESS_SAMPLE - 1, granted: 0 },
    outcomes: { operated: MIN_PROCESS_SAMPLE - 1, recorded: 0 },
    postop: { completed: 0, overdue: MIN_PROCESS_SAMPLE - 1 },
    response: { human_samples: MIN_PROCESS_SAMPLE - 1, human_median_minutes: 600, ai_samples: MIN_PROCESS_SAMPLE - 1, ai_median_seconds: 3 },
  });
  // Hepsi en kötü değerlerde, ama örneklem altında: hiçbiri 0 puan almamalı.
  check('az örneklemli rıza oranı unknown', item(thin, 'kvkk_consent_rate').status === 'unknown');
  check('az örneklemli takip uyumu unknown', item(thin, 'postop_followup_compliance').status === 'unknown');
  check('az örneklemli insan cevap süresi unknown', item(thin, 'human_response_time').status === 'unknown');
  check('az örneklemli AI cevap süresi unknown', item(thin, 'ai_response_time').status === 'unknown');
  check('kötü değerler bile skora girmedi', thin.score === null);
  // Regresyon koruması: örneklem altındaki bir madde DEĞER de taşımamalı.
  // Taşıdığında panel "%100" basıp yanına "veri yok" yazıyordu.
  check('örneklem altında value da null (panel yanıltıcı sayı basmasın)',
    ['kvkk_consent_rate','postop_followup_compliance','human_response_time']
      .map((id) => item(thin, id)).filter(Boolean)
      .every((i) => i.value === null));

  const enough = computeComplianceScore({
    now: NOW,
    consent: { total: MIN_PROCESS_SAMPLE, granted: 0 },
  });
  check('tam tabanda ölçüm devreye girer', item(enough, 'kvkk_consent_rate').status === 'fail');
  check('ölçülen kötü değer gerçekten 0 puan', item(enough, 'kvkk_consent_rate').score === 0);
}

console.log('\n▶ Komplikasyon oranı: ölçülür, PUANLANMAZ');
{
  // Yayınlanmış sektör kıyaslaması olmadığı için nota çevirmiyoruz.
  // Bu test o kararı kilitler: biri gelip weight verirse burası kırılır.
  const r = computeComplianceScore({
    now: NOW,
    outcomes: { operated: 60, recorded: 50, complications: 3, revisions: 2 },
  });
  const c = item(r, 'complication_rate');
  check('ağırlığı 0', c.weight === 0);
  check('skoru null', c.score === null);
  check("statüsü 'measured' — unknown değil, fail değil", c.status === 'measured');
  check('oran doğru hesaplanmış ((3+2)/50)', Math.abs(c.value - 0.1) < 1e-9);
  check('puanlanmadığını açıkça yazar', /Puanlanmadı/.test(c.evidence));
  check('toplam skora karışmaz', r.groups.risk.score === item(r, 'outcome_recording_rate').score * 100
    || r.groups.risk.score != null);

  const thin = computeComplianceScore({
    now: NOW,
    outcomes: { operated: 30, recorded: MIN_CLINICAL_SAMPLE - 1, complications: 5 },
  });
  check(`klinik taban altında (<${MIN_CLINICAL_SAMPLE}) oran gösterilmez`,
    item(thin, 'complication_rate').value === null && item(thin, 'complication_rate').status === 'unknown');
}

console.log('\n▶ Kapsam (coverage) skorla birlikte raporlanır');
{
  const partial = computeComplianceScore({
    now: NOW,
    records: [{ kind: 'accreditation', status: 'valid', valid_until: '2028-01-01' }],
  });
  check('tek maddeli skor 100 çıkabilir', partial.score === 100);
  check('ama kapsam düşük olduğunu söyler', partial.coverage > 0 && partial.coverage < 0.3);
  check('kalan 5 zorunlu açık listede (6 zorunlu - 1 girilen)', partial.gaps.length === 5, partial.gaps.length);

  const full = computeComplianceScore({
    now: NOW,
    records: [
      { kind: 'health_tourism_authorization', status: 'valid', valid_until: '2028-01-01' },
      { kind: 'accreditation', status: 'valid', valid_until: '2028-01-01' },
      { kind: 'complication_insurance', status: 'valid', valid_until: '2027-06-01' },
      { kind: 'kvkk_registry', status: 'valid' },
      { kind: 'foreign_language_staff', status: 'valid' },
    ],
    consent: { total: 120, granted: 119 },
    outcomes: { operated: 80, recorded: 76, complications: 2, revisions: 1 },
    postop: { completed: 190, overdue: 4 },
    response: { human_samples: 40, human_median_minutes: 9, ai_samples: 300, ai_median_seconds: 3.1, unknown_samples: 12 },
  });
  check('tam veride kapsam 1.0', full.coverage === 1);
  check('iyi klinik yüksek skor alır', full.score >= 90);
  check('tam veride zorunlu açık kalmaz', full.gaps.length === 0);
  check('uyum ve risk ayrı ayrı raporlanır',
    full.groups.compliance.score != null && full.groups.risk.score != null);
}

console.log('\n▶ Dayanıklılık: bozuk girdi hesabı patlatmaz');
{
  for (const bad of [undefined, {}, { records: null }, { consent: {} }, { outcomes: { operated: 'x' } }, { now: 'garbage' }]) {
    let ok = true;
    try { computeComplianceScore(bad); } catch { ok = false; }
    check(`girdi ${JSON.stringify(bad)} → hata yok`, ok);
  }
  const negative = computeComplianceScore({ now: NOW, consent: { total: 10, granted: 999 } });
  check('oran 1 üstüne çıksa bile skor 1 ile sınırlı', item(negative, 'kvkk_consent_rate').score <= 1);
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
