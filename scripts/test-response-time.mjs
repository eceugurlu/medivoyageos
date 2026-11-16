// İlk Yanıt Süresi — saf hesaplama. DB yok, ağ yok.
// Run: npm run check:response-time
import { computeResponseTimeStats, MIN_RESPONSE_SAMPLE } from '../src/services/responseTime.js';
import { DEFAULT_BUSINESS_HOURS, isWithinBusinessHours } from '../src/services/businessHours.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
// Tek turluk veri — her senaryoda n=1 yetersiz olur, o yüzden her çağrıda
// AYNI senaryoyu MIN_RESPONSE_SAMPLE kadar tekrarlıyoruz (n eşiğini
// aşırmak için), ama değer kontrolünü hep ilk/tek örnekten yapıyoruz.
const repeat = (turn, n = MIN_RESPONSE_SAMPLE) => Array.from({ length: n }, () => ({ ...turn }));

console.log(`▶ Mesai saatleri varsayılanı: ${JSON.stringify(DEFAULT_BUSINESS_HOURS)}`);
{
  check('varsayılan: Pazartesi–Cumartesi', DEFAULT_BUSINESS_HOURS.closedWeekdays.length === 1 && DEFAULT_BUSINESS_HOURS.closedWeekdays[0] === 6);
  check('varsayılan: 09:00–19:00', DEFAULT_BUSINESS_HOURS.openHour === 9 && DEFAULT_BUSINESS_HOURS.closeHour === 19);
  check('varsayılan: Europe/Istanbul', DEFAULT_BUSINESS_HOURS.timezone === 'Europe/Istanbul');
}

console.log('\n▶ Senaryo 1 — gece mesajı (Çarşamba 02:00 yerel, 09:05 yerel cevap)');
{
  // 2026-11-17T23:00:00Z = Çarşamba 02:00 İstanbul; 2026-11-18T06:05:00Z = Çarşamba 09:05 İstanbul.
  const turn = { askedAt: '2026-11-17T23:00:00Z', repliedAt: '2026-11-18T06:05:00Z', byAi: true };
  check('mesai dışı: 02:00 mesai içinde değil', !isWithinBusinessHours(new Date(turn.askedAt)));
  const r = computeResponseTimeStats(repeat(turn), DEFAULT_BUSINESS_HOURS);
  check('toplam süre 25500 sn (7s5dk)', r.ai.avg_seconds === 25500, r.ai.avg_seconds);
  check('mesaiye-göre-düzeltilmiş süre 300 sn (09:00 açılışından 5dk)', r.ai.avg_business_adjusted_seconds === 300, r.ai.avg_business_adjusted_seconds);
}

console.log('\n▶ Senaryo 2 — Cuma gecesi mesajı (23:10 yerel → Cumartesi 09:07 yerel cevap)');
{
  // 2026-11-20T20:10:00Z = Cuma 23:10 İstanbul; 2026-11-21T06:07:00Z = Cumartesi 09:07 İstanbul.
  const turn = { askedAt: '2026-11-20T20:10:00Z', repliedAt: '2026-11-21T06:07:00Z', byAi: true };
  const r = computeResponseTimeStats(repeat(turn), DEFAULT_BUSINESS_HOURS);
  check('toplam süre 35820 sn (9s57dk)', r.ai.avg_seconds === 35820, r.ai.avg_seconds);
  check('Cumartesi mesaide (varsayılanda kapalı değil) → açılış ertesi gün 09:00, düzeltilmiş 420 sn', r.ai.avg_business_adjusted_seconds === 420, r.ai.avg_business_adjusted_seconds);
}

console.log('\n▶ Senaryo 3 — Pazar mesajı (11:00 yerel → Pazartesi 09:12 yerel cevap)');
{
  // 2026-11-22T08:00:00Z = Pazar 11:00 İstanbul; 2026-11-23T06:12:00Z = Pazartesi 09:12 İstanbul.
  const turn = { askedAt: '2026-11-22T08:00:00Z', repliedAt: '2026-11-23T06:12:00Z', byAi: true };
  check('Pazar tamamen kapalı', !isWithinBusinessHours(new Date(turn.askedAt)));
  const r = computeResponseTimeStats(repeat(turn), DEFAULT_BUSINESS_HOURS);
  check('toplam süre 79920 sn (22s12dk)', r.ai.avg_seconds === 79920, r.ai.avg_seconds);
  check('Pazar atlanıp Pazartesi 09:00 açılışına göre düzeltilmiş 720 sn', r.ai.avg_business_adjusted_seconds === 720, r.ai.avg_business_adjusted_seconds);
}

console.log('\n▶ Senaryo 4 — mesai içi mesaj (Salı 14:00 → 14:03)');
{
  // 2026-11-17T11:00:00Z = Salı 14:00 İstanbul; 2026-11-17T11:03:00Z = Salı 14:03 İstanbul.
  const turn = { askedAt: '2026-11-17T11:00:00Z', repliedAt: '2026-11-17T11:03:00Z', byAi: true };
  check('mesai içinde', isWithinBusinessHours(new Date(turn.askedAt)));
  const r = computeResponseTimeStats(repeat(turn), DEFAULT_BUSINESS_HOURS);
  check('toplam = düzeltilmiş (mesai içi mesajda düzeltme YOK)', r.ai.avg_seconds === 180 && r.ai.avg_business_adjusted_seconds === 180, r.ai);
}

console.log('\n▶ Senaryo 5 — hiç cevaplanmamış mesaj');
{
  const turns = [
    { askedAt: '2026-11-17T11:00:00Z', repliedAt: null, byAi: null },
    ...repeat({ askedAt: '2026-11-17T11:00:00Z', repliedAt: '2026-11-17T11:03:00Z', byAi: true }),
  ];
  let threw = false;
  let r;
  try { r = computeResponseTimeStats(turns, DEFAULT_BUSINESS_HOURS); } catch { threw = true; }
  check('patlamadı', !threw);
  check('cevapsız mesaj örnekleme dahil edilmedi (n hâlâ 5)', r.ai.n === MIN_RESPONSE_SAMPLE, r.ai.n);
  check('ortalamayı bozmadı (180 sn)', r.ai.avg_seconds === 180, r.ai.avg_seconds);
}

console.log('\n▶ Senaryo 6 — saat dilimi sınırı (açılış anının tam kendisi vs. bir saniye öncesi)');
{
  // 2026-11-17T06:00:00Z = Salı 09:00:00 İstanbul TAM açılış anı.
  const atOpen = { askedAt: '2026-11-17T06:00:00Z', repliedAt: '2026-11-17T06:05:00Z', byAi: true };
  check('açılış anının tam kendisi MESAİ İÇİ sayılır (kapsayıcı alt sınır)', isWithinBusinessHours(new Date(atOpen.askedAt)));
  const rOpen = computeResponseTimeStats(repeat(atOpen), DEFAULT_BUSINESS_HOURS);
  check('tam açılışta düzeltme yapılmaz (300 sn = 300 sn)', rOpen.ai.avg_seconds === 300 && rOpen.ai.avg_business_adjusted_seconds === 300, rOpen.ai);

  // 2026-11-17T05:59:59Z = Salı 08:59:59 İstanbul — açılıştan 1 sn önce.
  const beforeOpen = { askedAt: '2026-11-17T05:59:59Z', repliedAt: '2026-11-17T06:00:00Z', byAi: true };
  check('açılıştan 1 sn önce MESAİ DIŞI sayılır', !isWithinBusinessHours(new Date(beforeOpen.askedAt)));
  const rBefore = computeResponseTimeStats(repeat(beforeOpen), DEFAULT_BUSINESS_HOURS);
  check('toplam 1 sn ama düzeltilmiş 0 sn (cevap açılış anında geldi, negatif değil 0)', rBefore.ai.avg_seconds === 1 && rBefore.ai.avg_business_adjusted_seconds === 0, rBefore.ai);
}

console.log('\n▶ Örneklem eşiği: n<5 → "yetersiz veri", n≥5 → ortalama/medyan gösterilir');
{
  const turn = { askedAt: '2026-11-17T11:00:00Z', repliedAt: '2026-11-17T11:03:00Z', byAi: false };
  const insufficient = computeResponseTimeStats(repeat(turn, 4), DEFAULT_BUSINESS_HOURS);
  check('n=4 → insufficient', insufficient.human.status === 'insufficient', insufficient.human);
  check('n=4 → avg/median null (0 DEĞİL)', insufficient.human.avg_seconds === null && insufficient.human.median_seconds === null);

  const sufficient = computeResponseTimeStats(repeat(turn, 5), DEFAULT_BUSINESS_HOURS);
  check('n=5 → ok', sufficient.human.status === 'ok', sufficient.human);
  check('n=5 → avg/median dolu', sufficient.human.avg_seconds === 180 && sufficient.human.median_seconds === 180);
}

console.log('\n▶ Ortalama ve medyan doğruluğu (bilinen sabit değerlerle elle hesap)');
{
  const vals = [10, 20, 30, 40, 50]; // ortalama 30, medyan 30 (tek sayıda eleman, mesai içi → düzeltme yok)
  const turns = vals.map((s) => ({
    askedAt: '2026-11-17T11:00:00Z',
    repliedAt: new Date(new Date('2026-11-17T11:00:00Z').getTime() + s * 1000).toISOString(),
    byAi: true,
  }));
  const r = computeResponseTimeStats(turns, DEFAULT_BUSINESS_HOURS);
  check('ortalama 30 sn', r.ai.avg_seconds === 30, r.ai.avg_seconds);
  check('medyan (tek sayıda eleman) 30 sn', r.ai.median_seconds === 30, r.ai.median_seconds);

  const evenVals = [10, 20, 30, 40]; // çift sayıda — medyan ortanca ikinin ortalaması: (20+30)/2=25
  const evenTurns = evenVals.map((s) => ({
    askedAt: '2026-11-17T11:00:00Z',
    repliedAt: new Date(new Date('2026-11-17T11:00:00Z').getTime() + s * 1000).toISOString(),
    byAi: false,
  }));
  // n=4 < 5 olduğundan normalde "insufficient" olurdu — eşiği atlamak için
  // bir beşinci (uç) değer ekliyoruz ve medyanı buna göre tekrar hesaplıyoruz.
  evenTurns.push({ askedAt: '2026-11-17T11:00:00Z', repliedAt: new Date(new Date('2026-11-17T11:00:00Z').getTime() + 1000 * 1000).toISOString(), byAi: false });
  const r2 = computeResponseTimeStats(evenTurns, DEFAULT_BUSINESS_HOURS);
  // [10,20,30,40,1000] sıralı: 10,20,30,40,1000 → medyan ortanca eleman 30.
  check('5 elemanlı (biri uç değer) medyan ortalamadan etkilenmez: 30 sn', r2.human.median_seconds === 30, r2.human);
  check('ama ortalama uç değerden etkilenir: 220 sn', r2.human.avg_seconds === 220, r2.human.avg_seconds);
}

console.log('\n▶ AI ve insan ayrı raporlanır, karışmaz');
{
  const aiTurn = { askedAt: '2026-11-17T11:00:00Z', repliedAt: '2026-11-17T11:01:00Z', byAi: true };
  const humanTurn = { askedAt: '2026-11-17T11:00:00Z', repliedAt: '2026-11-17T11:10:00Z', byAi: false };
  const r = computeResponseTimeStats([...repeat(aiTurn), ...repeat(humanTurn)], DEFAULT_BUSINESS_HOURS);
  check('AI süresi 60 sn', r.ai.avg_seconds === 60, r.ai.avg_seconds);
  check('insan süresi 600 sn', r.human.avg_seconds === 600, r.human.avg_seconds);
  check('biri diğerini etkilemedi', r.ai.avg_seconds !== r.human.avg_seconds);
}

console.log('\n▶ Dayanıklılık');
{
  for (const bad of [undefined, null, [], [null, undefined, {}], [{ askedAt: 'çöp', repliedAt: 'çöp' }]]) {
    let ok = true;
    try { computeResponseTimeStats(bad, DEFAULT_BUSINESS_HOURS); } catch { ok = false; }
    check(`girdi ${JSON.stringify(bad)} → hata yok`, ok);
  }
  let ok = true;
  try { computeResponseTimeStats([{ askedAt: '2026-11-17T11:00:00Z', repliedAt: '2026-11-17T10:00:00Z', byAi: true }], DEFAULT_BUSINESS_HOURS); } catch { ok = false; }
  check('cevap, sorudan ÖNCE gelirse (bozuk veri) patlamaz, sessizce atılır', ok);
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
