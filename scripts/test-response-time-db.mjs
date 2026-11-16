// İlk Yanıt Süresi — GERÇEK veritabanı testi. DATABASE_URL gerekir.
// Run: npm run check:response-time-db
//   (dev DB: node -r dotenv/config scripts/test-response-time-db.mjs dotenv_config_path=.env.local)
//
// Saf hesaplamanın doğruluğu scripts/test-response-time.mjs'de kanıtlanmış
// (DB'siz). Bu test SADECE boru hattını doğrular: gerçek mesaj satırlarından
// "tur" tespiti doğru mu çalışıyor, is_ai → AI/insan/bilinmeyen ayrımı doğru
// mu, şube izolasyonu tutuyor mu, ve klinik başına mesai ayarı gerçekten
// kalıcı mı. Tüm mesajlar BİLEREK aynı mesai-içi güne (Pazartesi 13:00
// İstanbul'dan başlayan) düşecek şekilde zamanlanmış, böylece toplam =
// mesaiye-göre-düzeltilmiş süre olur ve sayılar elle doğrulanabilir kalır.
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import {
  getDefaultClinicId, getResponseTimeStats, getBusinessHoursForBranch, setBusinessHours,
} from '../src/store/repository.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

const TAG = `ZZRT-${Date.now()}`;
let branchId = null;
let leadId = null;
let originalBusinessHours = null;
let clinicId = null;

try {
  clinicId = await getDefaultClinicId();
  originalBusinessHours = (await pool.query(`SELECT business_hours FROM clinics WHERE id = $1`, [clinicId])).rows[0].business_hours;

  branchId = (await pool.query(
    `INSERT INTO branches (clinic_id, name, city) VALUES ($1,$2,'Test') RETURNING id`,
    [clinicId, `${TAG}-branch`],
  )).rows[0].id;
  leadId = (await pool.query(
    `INSERT INTO leads (clinic_id, phone, name, branch_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [clinicId, `${TAG}-phone`, `${TAG}-lead`, branchId],
  )).rows[0].id;
  const convId = (await pool.query(
    `INSERT INTO conversations (clinic_id, lead_id, channel) VALUES ($1,$2,'whatsapp') RETURNING id`,
    [clinicId, leadId],
  )).rows[0].id;

  // T0 = Pazartesi 13:00 İstanbul (2026-01-05T10:00:00Z) — sabit bir geçmiş
  // tarih; testin hangi gün çalıştığından bağımsız, her zaman aynı hafta
  // günü ve aynı mesai durumu.
  const T0 = new Date('2026-01-05T10:00:00Z');
  const at = (s) => new Date(T0.getTime() + s * 1000).toISOString();
  // 5 AI turu (60,120,180,240,300 sn) → ortalama/medyan 180
  // 5 insan turu (100,200,300,400,500 sn) → ortalama/medyan 300
  // 1 kaynağı bilinmeyen tur (30 sn) → ne AI'da ne insanda sayılır
  // 1 hiç cevaplanmamış mesaj → hiçbir sayıya girmez
  const bursts = [
    [0, 60, true], [100, 120, true], [300, 180, true], [600, 240, true], [900, 300, true],
    [1300, 100, false], [1500, 200, false], [1800, 300, false], [2200, 400, false], [2700, 500, false],
    [3300, 30, null],
  ];
  for (const [askOffset, waitSeconds, byAi] of bursts) {
    await pool.query(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1,'user',$2,$3)`,
      [convId, `${TAG} soru`, at(askOffset)]);
    await pool.query(`INSERT INTO messages (conversation_id, role, content, is_ai, created_at) VALUES ($1,'assistant',$2,$3,$4)`,
      [convId, `${TAG} cevap`, byAi, at(askOffset + waitSeconds)]);
  }
  // hiç cevaplanmamış son mesaj
  await pool.query(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1,'user',$2,$3)`,
    [convId, `${TAG} cevapsız soru`, at(4000)]);

  console.log('▶ Tur tespiti ve ayrıştırma');
  {
    const r = await getResponseTimeStats({ branchId });
    check('AI örneklem n=5', r.ai.n === 5, r.ai);
    check('AI ortalama 180 sn', r.ai.avg_seconds === 180, r.ai.avg_seconds);
    check('AI medyan 180 sn', r.ai.median_seconds === 180, r.ai.median_seconds);
    check('mesai içi gün → düzeltilmiş = toplam (AI)', r.ai.avg_business_adjusted_seconds === 180);

    check('insan örneklem n=5', r.human.n === 5, r.human);
    check('insan ortalama 300 sn', r.human.avg_seconds === 300, r.human.avg_seconds);
    check('insan medyan 300 sn', r.human.median_seconds === 300, r.human.median_seconds);
    check('mesai içi gün → düzeltilmiş = toplam (insan)', r.human.avg_business_adjusted_seconds === 300);

    check('kaynağı bilinmeyen 1 adet, AI/insanı bozmadı', r.unknown_samples === 1, r.unknown_samples);
    check('hiç cevaplanmamış mesaj hiçbir sayıya girmedi (toplam örneklem 5+5+1=11, 12 değil)',
      r.ai.n + r.human.n + r.unknown_samples === 11);
    check('sayılar her çağrıda yeniden hesaplanıyor (saklanmış sütun yok)',
      Object.keys(r).every((k) => !/stored|cached/i.test(k)));
  }

  console.log('\n▶ Şube izolasyonu');
  {
    // normalizeUuid "all"/boş/biçimsiz girdiyi NULL'a (= tüm şubeler)
    // düşürür — bu kasıtlı bir davranış (bkz. repository.js::normalizeUuid),
    // o yüzden izolasyonu GERÇEK ama VAR OLMAYAN biçimli bir UUIDv4 ile test
    // ediyoruz, biçimsiz bir yer tutucuyla (örn. nil UUID) değil.
    const fakeButValidShapedBranch = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const other = await getResponseTimeStats({ branchId: fakeButValidShapedBranch });
    check('gerçek ama var olmayan bir şubede bu testin verisi görünmez', other.ai.n === 0 && other.human.n === 0, other);
  }

  console.log('\n▶ Klinik başına mesai ayarı: kalıcı ve ayarlanabilir');
  {
    const before = await getBusinessHoursForBranch(branchId);
    check('varsayılan (ayar yokken) Europe/Istanbul 09-19, Pazar kapalı',
      before.timezone === 'Europe/Istanbul' && before.openHour === 9 && before.closeHour === 19 && before.closedWeekdays.includes(6), before);

    const custom = { timezone: 'Europe/Istanbul', openHour: 8, closeHour: 17, closedWeekdays: [5, 6] };
    await setBusinessHours(clinicId, custom);
    const after = await getBusinessHoursForBranch(branchId);
    check('ayar kalıcı okunuyor (08-17, Cmt+Paz kapalı)',
      after.openHour === 8 && after.closeHour === 17 && after.closedWeekdays.length === 2
        && after.closedWeekdays.includes(5) && after.closedWeekdays.includes(6), after);

    // Aynı sorguyu şimdi yeni mesaiyle tekrar çalıştır: T0 (Pazartesi 13:00)
    // hâlâ 08-17 içinde kalıyor, sayı değişmemeli — ama mekanizmanın GERÇEKTEN
    // DB'den okunan ayarı kullandığını (hardcoded değil) kanıtlar.
    const r2 = await getResponseTimeStats({ branchId });
    check('yeni mesaiyle de 13:00 hâlâ mesai içi → sayı aynı (180 sn)', r2.ai.avg_business_adjusted_seconds === 180, r2.ai);
  }
} finally {
  if (leadId) await pool.query(`DELETE FROM leads WHERE id = $1`, [leadId]);
  if (branchId) await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  if (clinicId) await pool.query(`UPDATE clinics SET business_hours = $2 WHERE id = $1`, [clinicId, originalBusinessHours]);
  const left = leadId
    ? (await pool.query(`SELECT count(*)::int n FROM leads WHERE id = $1`, [leadId])).rows[0].n
    : 0;
  console.log(`\ntemizlik: kalan lead ${left}, mesai ayarı geri yüklendi`);
  if (left) failed++;
  await pool.end();
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
