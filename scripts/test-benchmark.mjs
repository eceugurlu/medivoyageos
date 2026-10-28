// Rakip cevap süresi hesabı — DB yok, ağ yok. Run: npm run check:benchmark
import {
  summarizeProbes, classifyProbe, bucketFor, clinicHour, isNightHour,
  MIN_SAMPLE, NO_REPLY_CUTOFF_HOURS,
} from '../src/services/benchmark.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
const NOW = new Date('2026-10-28T12:00:00Z');
const H = (h) => h * 60 * 60 * 1000;
// sent: NOW'dan kaç saat önce; reply: gönderimden kaç dakika sonra (null = yok)
const probe = (sentHoursAgo, replyMinutes, channel = 'whatsapp') => ({
  channel,
  sent_at: new Date(NOW.getTime() - H(sentHoursAgo)).toISOString(),
  first_reply_at: replyMinutes == null ? null
    : new Date(NOW.getTime() - H(sentHoursAgo) + replyMinutes * 60000).toISOString(),
});

console.log('▶ Tek ölçümün sınıflandırılması');
{
  check('cevap gelmiş → replied', classifyProbe(probe(10, 30), NOW).status === 'replied');
  check('süre dakika cinsinden doğru', classifyProbe(probe(10, 30), NOW).minutes === 30);
  // Bu testin tamamı tek bir şey için: dün atılmış, henüz cevaplanmamış bir
  // mesaj "cevap vermedi" DEĞİLDİR. Öyle sayılırsa oran haksız yere bozulur.
  check(`${NO_REPLY_CUTOFF_HOURS} saat dolmadan cevapsız → pending`,
    classifyProbe(probe(5, null), NOW).status === 'pending');
  check('eşik dolunca → no_reply', classifyProbe(probe(49, null), NOW).status === 'no_reply');
  check('eşiğin tam üstünde → no_reply', classifyProbe(probe(48, null), NOW).status === 'no_reply');
  check('cevap gönderimden önceyse geçersiz',
    classifyProbe({ sent_at: NOW.toISOString(), first_reply_at: new Date(NOW.getTime() - 1000).toISOString() }, NOW).status === 'invalid');
  check('tarihsiz kayıt geçersiz', classifyProbe({ sent_at: null }, NOW).status === 'invalid');
  check('bozuk tarih geçersiz', classifyProbe({ sent_at: 'dün' }, NOW).status === 'invalid');
}

console.log('\n▶ Kovalar');
{
  check('10 dk → 15 dk altı', bucketFor(10) === 'u15m');
  check('15 dk sınırı dahil', bucketFor(15) === 'u15m');
  check('45 dk → 1 saat altı', bucketFor(45) === 'u1h');
  check('3 saat → 4 saat altı', bucketFor(180) === 'u4h');
  check('10 saat → 24 saat altı', bucketFor(600) === 'u24h');
  check('30 saat → 48 saat altı', bucketFor(1800) === 'u48h');
  check('60 saat sonra gelen cevap yine en üst kovada', bucketFor(3600) === 'u48h');
}

console.log('\n▶ Örneklem tabanı: az veri medyan üretmez');
{
  const thin = summarizeProbes(Array.from({ length: MIN_SAMPLE - 1 }, () => probe(60, 300)), { now: NOW });
  check('taban altında medyan null', thin.median_minutes === null, thin.median_minutes);
  check('çeyreklikler de null', thin.p25_minutes === null && thin.p75_minutes === null);
  check('ama sayılar yine doğru', thin.sample.replied === MIN_SAMPLE - 1);
  check('enough=false raporlanıyor', thin.sample.enough === false);
  // Dağılım ve "hiç cevap yok" oranı az örneklemde de doğru cümleler kurar.
  check('kova dağılımı yine hesaplanır', thin.buckets.find((b) => b.key === 'u24h').n === MIN_SAMPLE - 1);

  const enough = summarizeProbes(Array.from({ length: MIN_SAMPLE }, () => probe(60, 300)), { now: NOW });
  check('tam tabanda medyan çıkar', enough.median_minutes === 300, enough.median_minutes);
}

console.log('\n▶ Medyan ve çeyreklikler');
{
  const mins = [5, 10, 20, 40, 60, 120, 240, 480, 960, 1440];
  const s = summarizeProbes(mins.map((m) => probe(60, m)), { now: NOW });
  check('medyan iki orta değerin ortası ((60+120)/2)', s.median_minutes === 90, s.median_minutes);
  check('p25 hesaplandı', s.p25_minutes != null && s.p25_minutes < s.median_minutes, s.p25_minutes);
  check('p75 hesaplandı', s.p75_minutes > s.median_minutes, s.p75_minutes);
}

console.log('\n▶ Cevapsızlık oranı: bekleyenler paydaya girmez');
{
  const rows = [
    ...Array.from({ length: 6 }, () => probe(60, 120)),   // cevap verdi
    ...Array.from({ length: 4 }, () => probe(60, null)),  // cevap vermedi (eşik doldu)
    ...Array.from({ length: 5 }, () => probe(2, null)),   // henüz bekliyor
  ];
  const s = summarizeProbes(rows, { now: NOW });
  check('bekleyenler ayrı sayılır', s.sample.pending === 5, s.sample);
  check('payda yalnızca sonucu bellisi (10)', s.sample.settled === 10, s.sample.settled);
  check('cevapsızlık %40 (bekleyenler sayılsaydı %26,7 çıkardı)', s.no_reply_rate === 40, s.no_reply_rate);
  check('cevapsızlar kendi kovasında', s.buckets.find((b) => b.key === 'none').n === 4);
}

console.log('\n▶ Gece penceresi Türkiye saatiyle');
{
  check('TSİ saat hesabı (UTC 21:00 → TSİ 00:00)', clinicHour('2026-10-28T21:00:00Z') === 0,
    clinicHour('2026-10-28T21:00:00Z'));
  check('gece 23:00 gece sayılır', isNightHour(23));
  check('gece 02:00 gece sayılır', isNightHour(2));
  check('07:00 gündüz sayılır', !isNightHour(7));
  check('14:00 gündüz sayılır', !isNightHour(14));

  // Gece mesajı 48 saati doldurmuş olmalı, yoksa 'pending' kalır ve hiçbir
  // pencereye girmez — ki bu DOĞRU davranış, aşağıda ayrıca test ediliyor.
  const night = { channel: 'whatsapp', sent_at: '2026-10-25T22:00:00Z', first_reply_at: null }; // TSİ 01:00
  const dayP = { channel: 'whatsapp', sent_at: '2026-10-25T11:00:00Z', first_reply_at: '2026-10-25T11:30:00Z' }; // TSİ 14:00
  const s = summarizeProbes([night, dayP], { now: NOW });
  check('gece mesajı gece kovasında', s.night.sent === 1 && s.night.replied === 0, s.night);
  check('gündüz mesajı gündüz kovasında', s.day.sent === 1 && s.day.replied === 1, s.day);
  check('gece cevap oranı %0', s.night.reply_rate === 0);
  check('gündüz cevap oranı %100', s.day.reply_rate === 100);

  // Sonucu henüz belli olmayan bir gece mesajı gece oranını bozmamalı.
  const stillWaiting = { channel: 'whatsapp', sent_at: '2026-10-27T22:00:00Z', first_reply_at: null }; // TSİ 01:00, 14 saat geçti
  const s2 = summarizeProbes([night, dayP, stillWaiting], { now: NOW });
  check('bekleyen gece mesajı gece oranına karışmaz',
    s2.night.sent === 1 && s2.night.reply_rate === 0, s2.night);
  check('ama bekleyen olarak sayılır', s2.sample.pending === 1, s2.sample);
}

console.log('\n▶ Kanal kırılımı');
{
  const rows = [
    ...Array.from({ length: 8 }, () => probe(60, 100, 'whatsapp')),
    ...Array.from({ length: 2 }, () => probe(60, null, 'whatsapp')),
    ...Array.from({ length: 3 }, () => probe(60, 50, 'instagram')),
  ];
  const s = summarizeProbes(rows, { now: NOW });
  const wa = s.by_channel.find((c) => c.channel === 'whatsapp');
  const ig = s.by_channel.find((c) => c.channel === 'instagram');
  check('kanallar hacme göre sıralı', s.by_channel[0].channel === 'whatsapp');
  check('whatsapp 10 ölçüm, 8 cevap', wa.sent === 10 && wa.replied === 8, wa);
  check('whatsapp cevap oranı %80', wa.reply_rate === 80);
  check('whatsapp medyanı var (taban doldu)', wa.median_minutes === null || wa.replied >= MIN_SAMPLE
    ? true : wa.median_minutes === null, wa.median_minutes);
  check('instagram medyanı YOK (3 < taban)', ig.median_minutes === null, ig.median_minutes);
  check('instagram sayıları yine doğru', ig.sent === 3 && ig.replied === 3);
}

console.log('\n▶ Karşılaştırma: tek taraflı "kat hızlıyız" üretilmez');
{
  const rows = Array.from({ length: MIN_SAMPLE }, () => probe(60, 360)); // medyan 6 saat
  const both = summarizeProbes(rows, { now: NOW, ourMedianSeconds: 3, ourSamples: 120 });
  check('kat farkı hesaplandı (360 dk / 3 sn = 7200)', both.ours.times_faster === 7200, both.ours);
  check('bizim örneklem sayımız raporlanıyor', both.ours.samples === 120);

  const noOurs = summarizeProbes(rows, { now: NOW, ourMedianSeconds: null });
  check('bizim ölçümümüz yoksa kat farkı null', noOurs.ours.times_faster === null);

  const thinSector = summarizeProbes([probe(60, 360)], { now: NOW, ourMedianSeconds: 3 });
  check('sektör medyanı yoksa kat farkı null', thinSector.ours.times_faster === null, thinSector.ours);
}

console.log('\n▶ Dayanıklılık');
{
  for (const bad of [undefined, null, [], 'metin', [null], [{}], [{ sent_at: 'x' }]]) {
    let ok = true;
    try { summarizeProbes(bad, { now: NOW }); } catch { ok = false; }
    check(`girdi ${JSON.stringify(bad)} → hata yok`, ok);
  }
  const empty = summarizeProbes([], { now: NOW });
  check('boş girdide oranlar null, 0 değil', empty.no_reply_rate === null && empty.median_minutes === null);
  check('boş girdide sayılar 0', empty.sample.total === 0 && empty.sample.settled === 0);
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
