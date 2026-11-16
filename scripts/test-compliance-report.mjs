// Aylık Uyum Raporu — saf hesap. DB yok, ağ yok. Run: npm run check:compliance-report
import { getClinicMonthWindow, monthLabel, buildComplianceReport } from '../src/services/complianceReport.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

console.log('▶ Ay penceresi: klinik yerel saatine göre takvim ayı');
{
  // 15 Kasım 2026, TSİ öğlen — ay içinde bir gün.
  const now = new Date('2026-11-15T12:00:00Z');
  const { monthStart, monthEnd } = getClinicMonthWindow(now, 0);
  check('ay başlangıcı 1 Kasım (TSİ gece yarısı → UTC 21:00, önceki gün)',
    monthStart.toISOString() === '2026-10-31T21:00:00.000Z', monthStart.toISOString());
  check('ay sonu 1 Aralık', monthEnd.toISOString() === '2026-11-30T21:00:00.000Z', monthEnd.toISOString());
  check('pencere tam 30 gün (Kasım)', (monthEnd - monthStart) / 86_400_000 === 30);

  const prev = getClinicMonthWindow(now, -1);
  check('offsetMonths=-1 → geçen ay (Ekim)', prev.monthStart.toISOString() === '2026-09-30T21:00:00.000Z', prev.monthStart.toISOString());
  check('geçen ayın sonu bu ayın başlangıcına eşit (kesişme/boşluk yok)',
    prev.monthEnd.getTime() === monthStart.getTime());
}

console.log('\n▶ Ay sınırında (yıl dönümü)');
{
  const now = new Date('2026-01-10T12:00:00Z');
  const prev = getClinicMonthWindow(now, -1);
  check('Ocak\'ın bir önceki ayı Aralık 2025', monthLabel(prev.monthStart) === '2025-12', monthLabel(prev.monthStart));
}

console.log('\n▶ monthLabel biçimi');
{
  check('YYYY-MM biçiminde', /^\d{4}-\d{2}$/.test(monthLabel(new Date('2026-11-15T12:00:00Z'))));
}

console.log('\n▶ Takip oranı: vadesi gelmemiş görev paydaya girmez');
{
  const none = buildComplianceReport({ postOpDue: 0, postOpSent: 0 });
  check('vadesi hiç gelmemişse oran null (0/0 ≠ %100)', none.follow_up_rate === null, none.follow_up_rate);

  const full = buildComplianceReport({ postOpDue: 20, postOpSent: 18 });
  check('18/20 → %90', full.follow_up_rate === 90, full.follow_up_rate);
}

console.log('\n▶ Gece kapsamı: mesaj yoksa oran null');
{
  const none = buildComplianceReport({ nightMessages: 0, nightReplied: 0 });
  check('gece hiç mesaj yoksa oran null', none.night_coverage_rate === null);
  const some = buildComplianceReport({ nightMessages: 10, nightReplied: 9 });
  check('9/10 → %90', some.night_coverage_rate === 90);
}

console.log('\n▶ Dillere göre mesaj sayısı: pay yüzdeleri doğru, sıralı');
{
  const r = buildComplianceReport({
    messagesByLanguage: [
      { language: 'tr', count: 40 }, { language: 'de', count: 30 },
      { language: 'en', count: 20 }, { language: null, count: 10 },
    ],
  });
  check('toplam mesaj 100', r.total_messages === 100, r.total_messages);
  check('en çok konuşulan dil önce gelir (büyükten küçüğe sıralı)', r.messages_by_language[0].language === 'tr');
  check('tr payı %40', r.messages_by_language.find((x) => x.language === 'tr').share === 40);
  check('dili bilinmeyenler de sayılır ama distinct_languages\'a girmez',
    r.distinct_languages === 3, r.distinct_languages);
  check('null dil satırı da toplamda var (10 mesaj kaybolmadı)',
    r.messages_by_language.find((x) => x.language === null).count === 10);
}

console.log('\n▶ Dayanıklılık');
{
  for (const bad of [undefined, null, {}, 'metin', 42]) {
    let ok = true;
    try { buildComplianceReport(bad); } catch { ok = false; }
    check(`girdi ${JSON.stringify(bad)} → hata yok`, ok);
  }
  const empty = buildComplianceReport({});
  check('boş girdide sayılar 0, oranlar null', empty.new_leads === 0 && empty.follow_up_rate === null);
  const nonArray = buildComplianceReport({ messagesByLanguage: 'metin' });
  check('messagesByLanguage dizi değilse boş diziye düşer', Array.isArray(nonArray.messages_by_language) && nonArray.messages_by_language.length === 0);
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
