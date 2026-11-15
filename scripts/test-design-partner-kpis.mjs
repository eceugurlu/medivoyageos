// Tasarım Ortağı KPI hesabı — DB yok, ağ yok. Run: npm run check:dp-kpis
import { computeProgress, buildKpiReport, METRICS, METRIC_IDS } from '../src/services/designPartnerKpis.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

console.log('▶ Hedef yoksa ilerleme YOK, %0 DEĞİL');
{
  const r = computeProgress({ metric: 'response_time_seconds', baseline: null, target: null, current: 300 });
  check('progress null', r.progress === null, r.progress);
  check("statü 'no_goal'", r.status === 'no_goal');
}

console.log('\n▶ Hedef var ama ölçüm yok');
{
  const r = computeProgress({ metric: 'response_time_seconds', baseline: 7200, target: 60, current: null });
  check('progress null', r.progress === null);
  check("statü 'no_data'", r.status === 'no_data');
}

console.log('\n▶ Azalması gereken metrik (cevap süresi)');
{
  // Başlangıç 2 saat (7200sn), hedef 1 dakika (60sn). Yarı yolda = 3630sn.
  const half = computeProgress({ metric: 'response_time_seconds', baseline: 7200, target: 60, current: 3630 });
  check('yarı yolda ilerleme ~0.5', Math.abs(half.progress - 0.5) < 0.01, half.progress);
  check("statü 'on_track' (>=0.5)", half.status === 'on_track');

  const reached = computeProgress({ metric: 'response_time_seconds', baseline: 7200, target: 60, current: 45 });
  check('hedefin altına inince ulaşıldı sayılır', reached.status === 'reached', reached);
  check('ilerleme 1 ile sınırlı (hedefi aşsa bile)', reached.progress === 1, reached.progress);

  const behind = computeProgress({ metric: 'response_time_seconds', baseline: 7200, target: 60, current: 7000 });
  check("statü 'behind' (<0.5)", behind.status === 'behind', behind.progress);
  check('ilerleme negatife düşmez (kötüleşse bile)', behind.progress >= 0, behind.progress);

  const worse = computeProgress({ metric: 'response_time_seconds', baseline: 7200, target: 60, current: 9000 });
  check('başlangıçtan da kötüleşirse ilerleme 0, negatif değil', worse.progress === 0, worse.progress);
}

console.log('\n▶ Artması gereken metrik (randevu dönüşümü)');
{
  const half = computeProgress({ metric: 'appointment_conversion_rate', baseline: 0.1, target: 0.3, current: 0.2 });
  check('yarı yolda ilerleme ~0.5', Math.abs(half.progress - 0.5) < 0.01, half.progress);

  const reached = computeProgress({ metric: 'appointment_conversion_rate', baseline: 0.1, target: 0.3, current: 0.35 });
  check('hedefin üstüne çıkınca ulaşıldı sayılır', reached.status === 'reached');
}

console.log('\n▶ Kenar durumlar');
{
  const same = computeProgress({ metric: 'response_time_seconds', baseline: 100, target: 100, current: 50 });
  check('başlangıç=hedef → tanımsız, patlamaz', same.status === 'no_goal', same);

  let threw = false;
  try { computeProgress({ metric: 'uydurma_metrik', baseline: 1, target: 2, current: 1.5 }); } catch { threw = true; }
  check('bilinmeyen metrik reddedilir', threw);

  check(`${METRICS.length} metrik tanımlı`, METRICS.length === 2, METRICS.length);
  check('metrik kimlikleri tekil', new Set(METRIC_IDS).size === METRIC_IDS.length);
}

console.log('\n▶ Rapor derleme: eksik hedefler diğerlerini etkilemez');
{
  const goals = [{ metric: 'response_time_seconds', baseline_value: 7200, target_value: 60 }];
  const report = buildKpiReport(goals, { response_time_seconds: 3630, appointment_conversion_rate: 0.25 });
  check('2 metrik de raporda', report.length === 2);
  const rt = report.find((r) => r.metric === 'response_time_seconds');
  const conv = report.find((r) => r.metric === 'appointment_conversion_rate');
  check('hedefi olan metrik hesaplandı', rt.status === 'on_track', rt);
  check('hedefi OLMAYAN metrik no_goal, ölçüm varken bile', conv.status === 'no_goal', conv);
  check('ölçülen değer yine de taşınıyor (gösterim için)', conv.current === 0.25, conv.current);
}

console.log('\n▶ Dayanıklılık');
{
  for (const bad of [undefined, null, [], 'metin']) {
    let ok = true;
    try { buildKpiReport(bad, {}); } catch { ok = false; }
    check(`goals=${JSON.stringify(bad)} → hata yok`, ok);
  }
  const r = computeProgress({ metric: 'response_time_seconds', baseline: 'çok', target: 60, current: 100 });
  check('sayı olmayan baseline → no_goal, patlamaz', r.status === 'no_goal', r);
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
