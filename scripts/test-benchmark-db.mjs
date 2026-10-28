// Rakip kıyaslama — GERÇEK veritabanı. Run: npm run check:benchmark-db
//   (dev DB: node -r dotenv/config scripts/test-benchmark-db.mjs dotenv_config_path=.env.local)
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import {
  getDefaultClinicId, addBenchmarkProbe, setBenchmarkReply,
  deleteBenchmarkProbe, listBenchmarkProbes, getBenchmarkStats,
} from '../src/store/repository.js';
import { MIN_SAMPLE, NO_REPLY_CUTOFF_HOURS } from '../src/services/benchmark.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

const TAG = `ZZBM-${Date.now()}`;
const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const ids = [];

try {
  const clinicId = await getDefaultClinicId();
  console.log('▶ Girdi doğrulaması');
  {
    const cases = [
      [{ label: 'A', channel: 'telepati', sent_at: ago(2) }, /channel/],
      [{ label: '', channel: 'whatsapp', sent_at: ago(2) }, /label/],
      [{ label: 'A', channel: 'whatsapp' }, /sent_at/],
      [{ label: 'A', channel: 'whatsapp', sent_at: 'dün' }, /sent_at/],
      [{ label: 'A', channel: 'whatsapp', sent_at: ago(2), first_reply_at: 'yarın' }, /first_reply_at/],
      [{ label: 'A', channel: 'whatsapp', sent_at: ago(2), first_reply_at: ago(5) }, /before sent_at/],
    ];
    for (const [input, re] of cases) {
      let msg = null;
      try { await addBenchmarkProbe(input); } catch (e) { msg = e.message; }
      check(`reddedildi: ${re.source}`, msg != null && re.test(msg), msg);
    }
  }

  console.log('\n▶ Kayıt ve cevap işaretleme');
  {
    const p = await addBenchmarkProbe({
      label: `${TAG}-1`, channel: 'whatsapp', city: 'İstanbul', treatment: 'Saç ekimi',
      language: 'de', sent_at: ago(10), note: 'test',
    });
    ids.push(p.id);
    check('ölçüm yazıldı', Boolean(p.id) && p.label === `${TAG}-1`);
    check('cevap boş başlar', p.first_reply_at === null);

    const marked = await setBenchmarkReply(p.id, new Date(Date.now() - 9 * 3600_000).toISOString());
    check('cevap zamanı işaretlendi', marked.first_reply_at !== null);

    let msg = null;
    try { await setBenchmarkReply(p.id, ago(20)); } catch (e) { msg = e.message; }
    check('gönderimden önceye cevap yazılamaz', /before sent_at/.test(msg || ''), msg);

    const cleared = await setBenchmarkReply(p.id, null);
    check('cevap geri alınabilir (yanlış işaretlendiyse)', cleared.first_reply_at === null);
    await setBenchmarkReply(p.id, new Date(Date.now() - 9 * 3600_000).toISOString());

    msg = null;
    try { await setBenchmarkReply('00000000-0000-4000-8000-000000000000', new Date().toISOString()); }
    catch (e) { msg = e.message; }
    check('olmayan ölçüm 404 mesajı verir', /not found/.test(msg || ''), msg);
  }

  console.log('\n▶ İstatistik gerçek satırlardan hesaplanıyor');
  {
    // Taban dolacak kadar ölçüm: 8 cevaplı + 3 cevapsız (eşik dolmuş) + 2 bekleyen
    for (let i = 0; i < 8; i++) {
      ids.push((await addBenchmarkProbe({
        label: `${TAG}-r${i}`, channel: 'whatsapp',
        sent_at: ago(80), first_reply_at: new Date(Date.now() - (80 - 4) * 3600_000).toISOString(),
      })).id);
    }
    for (let i = 0; i < 3; i++) {
      ids.push((await addBenchmarkProbe({
        label: `${TAG}-n${i}`, channel: 'instagram', sent_at: ago(NO_REPLY_CUTOFF_HOURS + 5),
      })).id);
    }
    for (let i = 0; i < 2; i++) {
      ids.push((await addBenchmarkProbe({
        label: `${TAG}-p${i}`, channel: 'instagram', sent_at: ago(3),
      })).id);
    }

    const st = await getBenchmarkStats();
    const mine = st.probes.filter((p) => p.label.startsWith(TAG));
    check('tüm test satırları listede', mine.length === ids.length, { got: mine.length, want: ids.length });
    check('bekleyenler ayrı sayıldı', st.sample.pending >= 2, st.sample);
    check('sonucu belli olanlar tabanı geçti', st.sample.settled >= MIN_SAMPLE, st.sample.settled);
    check('medyan hesaplandı', st.median_minutes != null, st.median_minutes);
    check('cevapsızlık oranı hesaplandı', st.no_reply_rate != null, st.no_reply_rate);
    check('kova dağılımı toplam sonucu bellilere eşit',
      st.buckets.reduce((s2, b) => s2 + b.n, 0) === st.sample.settled,
      { buckets: st.buckets.reduce((s2, b) => s2 + b.n, 0), settled: st.sample.settled });
    check('kanal kırılımında whatsapp ve instagram var',
      st.by_channel.some((c) => c.channel === 'whatsapp') && st.by_channel.some((c) => c.channel === 'instagram'));
    check('bizim ölçümümüz de geldi (getResponseTimes ile birleşti)',
      Object.prototype.hasOwnProperty.call(st.ours, 'median_seconds'), st.ours);
    check('gece/gündüz pencereleri dolduruldu',
      st.night.sent + st.day.sent === st.sample.settled, { night: st.night.sent, day: st.day.sent });
  }

  console.log('\n▶ Silme');
  {
    const victim = ids.pop();
    await deleteBenchmarkProbe(victim);
    const left = (await listBenchmarkProbes()).filter((p) => p.id === victim);
    check('silinen ölçüm listeden düştü', left.length === 0);
    let msg = null;
    try { await deleteBenchmarkProbe(victim); } catch (e) { msg = e.message; }
    check('ikinci silme 404', /not found/.test(msg || ''), msg);
  }

  console.log('\n▶ Klinik ismi sızmıyor');
  {
    // Tablo tasarımının kuralı: gerçek klinik adı tutulmaz. Bunu kod
    // zorlayamaz (etiket serbest metin) ama şema da teşvik etmemeli:
    // ayrı bir "clinic_name" kolonu olmadığını kilitliyoruz.
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'benchmark_probes'`,
    )).rows.map((r) => r.column_name);
    check('clinic_name gibi bir kolon yok', !cols.some((c) => /clinic_name|competitor|real_name/.test(c)), cols);
    check('label kolonu var (anonim etiket)', cols.includes('label'));
  }
} finally {
  for (const id of ids) await pool.query(`DELETE FROM benchmark_probes WHERE id = $1`, [id]);
  await pool.query(`DELETE FROM benchmark_probes WHERE label LIKE $1`, [`${TAG}%`]);
  const left = (await pool.query(
    `SELECT count(*)::int n FROM benchmark_probes WHERE label LIKE $1`, [`${TAG}%`],
  )).rows[0].n;
  console.log(`\ntemizlik: kalan ölçüm ${left}`);
  if (left) failed++;
  await pool.end();
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
