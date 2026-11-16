// Risk & Uyum skoru — GERÇEK veritabanı testi. DATABASE_URL gerekir.
// Run: npm run check:compliance-db
//   (yerel .env localhost'u gösteriyor; dev DB'ye karşı çalıştırmak için:
//    node -r dotenv/config scripts/test-compliance-db.mjs dotenv_config_path=.env.local)
//
// İzolasyon hilesi: tüm sorgular şube kapsamı (branchId) kabul ediyor, bu yüzden
// tek kullanımlık bir şube açıp bütün satırları ona bağlıyoruz. Böylece gerçek
// public fonksiyonlar çağrılır (SQL'i teste kopyalamak yok) ama dönen sayılar
// yalnızca bu testin verisidir. Her şey finally içinde silinir.
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import {
  getDefaultClinicId, getComplianceSnapshot, getResponseTimes, getOutcomesByDoctor,
  upsertComplianceRecord, listComplianceRecords, setLeadOutcome,
  markOperatedIfUnset, getConversationDetail,
} from '../src/store/repository.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
const near = (a, b, tol = 0.6) => a != null && Math.abs(Number(a) - b) <= tol;

const TAG = `ZZTEST-${Date.now()}`;
let branchId = null;
let doctorId = null;
let savedContract = null;

try {
  const clinicId = await getDefaultClinicId();

  // ── kurulum ──
  branchId = (await pool.query(
    `INSERT INTO branches (clinic_id, name, city) VALUES ($1,$2,'Test') RETURNING id`,
    [clinicId, `${TAG}-branch`],
  )).rows[0].id;
  doctorId = (await pool.query(
    `INSERT INTO doctors (clinic_id, name, specialty, api_token) VALUES ($1,$2,'Test',$3) RETURNING id`,
    [clinicId, `${TAG}-doctor`, `${TAG}-token`],
  )).rows[0].id;

  // 6 ameliyatlı hasta: 5'i sonucu kayıtlı (1 komplikasyon, 1 revizyon, 3 iyileşti),
  // 1'i kayıtsız. Rıza 6'da 5.
  const outcomes = ['complication', 'revision_needed', 'recovered', 'recovered', 'recovered', null];
  const leadIds = [];
  for (let i = 0; i < outcomes.length; i++) {
    const { rows } = await pool.query(
      `INSERT INTO leads (clinic_id, phone, name, branch_id, doctor_id, consent, operated_at, outcome_status, outcome_recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,current_date - 30, $7, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [clinicId, `${TAG}-${i}`, `${TAG} Lead ${i}`, branchId, doctorId, i !== 5, outcomes[i]],
    );
    leadIds.push(rows[0].id);
  }

  // Cevap süresi verisi. T0'dan itibaren üç tur:
  //   tur 1: hasta T0, hasta T0+600s, AI T0+601s       → AI 601 sn
  //          (ilk mesajdan ölçülürse 601; son mesajdan ölçülürse 1 — testin asıl konusu bu)
  //   tur 2: hasta T0+700s, insan T0+2500s             → insan 1800 sn = 30 dk
  //   tur 3: hasta T0+5000s, kaynağı bilinmeyen T0+5060s → unknown
  const convId = (await pool.query(
    `INSERT INTO conversations (clinic_id, lead_id, channel) VALUES ($1,$2,'whatsapp') RETURNING id`,
    [clinicId, leadIds[0]],
  )).rows[0].id;
  const T0 = new Date(Date.now() - 86400_000);
  const at = (s) => new Date(T0.getTime() + s * 1000).toISOString();
  const msgs = [
    ['user', null, 0], ['user', null, 600], ['assistant', true, 601],
    ['user', null, 700], ['assistant', false, 2500],
    ['user', null, 5000], ['assistant', null, 5060],
  ];
  for (const [role, isAi, offset] of msgs) {
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, is_ai, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [convId, role, `${TAG} msg`, isAi, at(offset)],
    );
  }

  // Takip görevleri: 4 tamam, 1 gecikmiş, 1 vadesi gelmemiş.
  for (const [status, dueOffsetDays] of [['sent', -10], ['sent', -9], ['sent', -8], ['sent', -7], ['pending', -2], ['pending', 5]]) {
    await pool.query(
      `INSERT INTO post_op_tasks (clinic_id, lead_id, kind, due_at, status)
       VALUES ($1,$2,'checkin', now() + ($3 || ' days')::interval, $4)`,
      [clinicId, leadIds[0], String(dueOffsetDays), status],
    );
  }

  // ── cevap süreleri ──
  console.log('\n▶ Cevap süresi: hastanın İLK mesajından ölçülür');
  const rt = await getResponseTimes({ branchId });
  check('AI turu sayısı 1', rt.ai_samples === 1, rt);
  check('AI medyanı 601 sn (son mesajdan ölçülse 1 çıkardı)', near(rt.ai_median_seconds, 601), rt.ai_median_seconds);
  check('insan turu sayısı 1', rt.human_samples === 1, rt);
  check('insan medyanı 30 dk', near(rt.human_median_minutes, 30, 0.2), rt.human_median_minutes);
  check('kaynağı bilinmeyen tur ayrı sayılır (is_ai NULL)', rt.unknown_samples === 1, rt);
  check('bilinmeyen, AI veya insan sayılmadı', rt.ai_samples + rt.human_samples === 2);

  // ── snapshot ──
  console.log('\n▶ Snapshot: pay ve payda ayrı gelir, oran motorda hesaplanır');
  const snap = await getComplianceSnapshot({ branchId });
  const item = (id) => snap.items.find((i) => i.id === id);
  check('rıza 6/5 doğru toplanmış', snap.raw.consent.total === 6 && snap.raw.consent.granted === 5, snap.raw.consent);
  check('ameliyat 6, kayıtlı sonuç 5', snap.raw.outcomes.operated === 6 && snap.raw.outcomes.recorded === 5, snap.raw.outcomes);
  check('1 komplikasyon + 1 revizyon', snap.raw.outcomes.complications === 1 && snap.raw.outcomes.revisions === 1, snap.raw.outcomes);
  check('takip: 4 tamam / 1 gecikmiş / 1 bekleyen',
    snap.raw.postop.completed === 4 && snap.raw.postop.overdue === 1 && snap.raw.postop.upcoming === 1, snap.raw.postop);

  console.log('\n▶ Eşikler gerçek veride de tutuyor');
  check('sonuç kayıt oranı puanlandı (6 >= 5)', item('outcome_recording_rate').score != null);
  check('sonuç kayıt oranı 5/6', near(item('outcome_recording_rate').value, 5 / 6, 0.001));
  check('komplikasyon oranı klinik taban altında gizlendi (5 < 20)',
    item('complication_rate').value === null && item('complication_rate').status === 'unknown');
  check('takip uyumu 4/5 = 0.8 (vadesi gelmemiş görev paydada değil)',
    near(item('postop_followup_compliance').value, 0.8, 0.001), item('postop_followup_compliance').value);
  // 4/5 = %80, bant (iyi 0.95 / kötü 0.60) içinde 0.57 puana denk → 'fail'.
  // Kasıtlı sert: beş hastadan birinin ameliyat sonrası takibinin yapılmaması
  // tıbbi bağlamda "idare eder" değildir.
  check('takip uyumu %80 → fail (bant sert, bilerek)', item('postop_followup_compliance').status === 'fail',
    item('postop_followup_compliance').score);

  console.log('\n▶ Doktor kırılımı');
  const mine = (await getOutcomesByDoctor({ branchId })).find((d) => d.doctor_id === doctorId);
  check('doktor satırı var', Boolean(mine));
  check('6 ameliyat, 5 kayıt', mine && mine.operated === 6 && mine.recorded === 5, mine);
  check('1 komplikasyon, 1 revizyon', mine && mine.complications === 1 && mine.revisions === 1, mine);
  check('ameliyatı olmayan doktorlar listede yok',
    (await getOutcomesByDoctor({ branchId })).every((d) => d.operated > 0));

  // ── belge kayıtları ──
  console.log('\n▶ Belge kaydı: beyan, doğrulama DEĞİL');
  savedContract = (await listComplianceRecords()).find((r) => r.kind === 'foreign_language_staff') || null;
  const rec = await upsertComplianceRecord('foreign_language_staff', {
    status: 'valid', issuer: `${TAG} Telekom`, reference: 'SOZ-1', valid_until: '2027-03-01',
  });
  check('kayıt yazıldı', rec.status === 'valid' && rec.issuer === `${TAG} Telekom`);
  check('verified_at panelden set EDİLEMEZ (null kalır)', rec.verified_at === null, rec.verified_at);
  const rec2 = await upsertComplianceRecord('foreign_language_staff', { status: 'expired' });
  check('aynı tür ikinci kez yazılınca güncellenir, çoğalmaz', rec2.status === 'expired');
  check('tek satır kaldı',
    (await listComplianceRecords()).filter((r) => r.kind === 'foreign_language_staff').length === 1);
  let rejected = false;
  try { await upsertComplianceRecord('not_a_real_kind', { status: 'valid' }); } catch { rejected = true; }
  check('bilinmeyen belge türü reddedilir', rejected);
  const coerced = await upsertComplianceRecord('foreign_language_staff', { status: 'çok iyi' });
  check("uydurma statü sessizce 'missing'e düşer, DB CHECK'ini patlatmaz", coerced.status === 'missing');

  console.log('\n▶ Bozuk tarih 500 değil, "tarih yok" olmalı');
  for (const bad of ['yakında', '2026-13-45', '2026-02-31', 'next year', '']) {
    let ok = true; let row = null;
    try { row = await upsertComplianceRecord('foreign_language_staff', { status: 'valid', valid_until: bad }); }
    catch { ok = false; }
    check(`valid_until=${JSON.stringify(bad)} → hata yok, null`, ok && row && row.valid_until === null);
  }
  const good = await upsertComplianceRecord('foreign_language_staff', { status: 'valid', valid_until: '2027-03-01' });
  // Date nesnesi DEĞİL, metin dönmeli: pg'nin yerel-gece-yarısı Date'i
  // son tarih sayacını bir gün kaydırıyordu.
  check('geçerli tarih YYYY-MM-DD metni olarak döner', good.valid_until === '2027-03-01', good.valid_until);
  check('tarih Date nesnesi olarak dönmüyor', !(good.valid_until instanceof Date));
  const badOp = await setLeadOutcome(leadIds[3], { operated_at: 'dün', outcome_status: 'recovered' });
  check('bozuk operated_at mevcut tarihi silmez (COALESCE + null)', badOp.operated_at !== null, badOp.operated_at);

  // ── sonuç yazma ──
  console.log('\n▶ Sonuç yazma');
  let badOutcome = false;
  try { await setLeadOutcome(leadIds[2], { outcome_status: 'mucize' }); } catch { badOutcome = true; }
  check('bilinmeyen sonuç statüsü reddedilir', badOutcome);
  const cleared = await setLeadOutcome(leadIds[2], { outcome_status: null });
  check('sonuç silinince outcome_recorded_at da null olur',
    cleared.outcome_status === null && cleared.outcome_recorded_at === null, cleared);
  check('operated_at silinmedi (COALESCE)', cleared.operated_at !== null, cleared.operated_at);
  const reset = await setLeadOutcome(leadIds[2], { outcome_status: 'recovered', outcome_note: 'ok' });
  check('yeniden yazılabilir ve zaman damgası döner',
    reset.outcome_status === 'recovered' && reset.outcome_recorded_at !== null);

  console.log('\n▶ Taburcu: tarihi kurar, sonucu ASLA');
  {
    // Taburcu akışı ameliyat tarihini varsayılan kurar ki hasta skorun
    // paydasına girsin. Sonucu kurmaz — tahmin edilen sonuç, veriyi kirletir.
    const fresh = (await pool.query(
      `INSERT INTO leads (clinic_id, phone, name, branch_id, doctor_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [clinicId, `${TAG}-fresh`, `${TAG} Fresh`, branchId, doctorId],
    )).rows[0].id;
    const set = await markOperatedIfUnset(fresh);
    check('ameliyat tarihi boşken bugüne kurulur', set === new Date().toISOString().slice(0, 10), set);
    const after = await getConversationDetail(fresh);
    check('sonuç otomatik kurulmadı', after.lead.outcome_status === null, after.lead.outcome_status);
    check('sonuç zaman damgası da boş', after.lead.outcome_recorded_at === null);

    // İkinci çağrı dolu tarihi EZMEMELİ: koordinatör gerçek tarihi düzeltmiş
    // olabilir ve ikinci bir taburcu tıklaması onu bugüne geri çekerdi.
    await setLeadOutcome(fresh, { operated_at: '2026-05-04' });
    const again = await markOperatedIfUnset(fresh);
    check('dolu tarih ikinci taburcuda ezilmez', again === null, again);
    const kept = await getConversationDetail(fresh);
    check('elle girilen tarih korundu', kept.lead.operated_at === '2026-05-04', kept.lead.operated_at);
    check('detay sorgusu tarihi metin döner (Date değil)', typeof kept.lead.operated_at === 'string');
  }

  console.log('\n▶ Skor ve kapsam birlikte raporlanır');
  check('skor sayı veya null, NaN değil', snap.score === null || Number.isFinite(snap.score), snap.score);
  check('kapsam 0..1 arasında', snap.coverage >= 0 && snap.coverage <= 1, snap.coverage);
  check('akreditasyon son tarihine kalan gün hesaplanmış',
    Number.isInteger(snap.deadlines.accreditation_days), snap.deadlines);
  check('madde sayısı 11', snap.items.length === 11, snap.items.length);
} finally {
  // ── temizlik ──
  if (branchId) {
    const leads = await pool.query(`SELECT id FROM leads WHERE name LIKE $1`, [`${TAG}%`]);
    for (const l of leads.rows) await pool.query(`DELETE FROM leads WHERE id = $1`, [l.id]);
    await pool.query(`DELETE FROM doctors WHERE id = $1`, [doctorId]);
    await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  }
  const clinicId = await getDefaultClinicId().catch(() => null);
  if (clinicId) {
    await pool.query(`DELETE FROM compliance_records WHERE clinic_id = $1 AND kind = 'foreign_language_staff'`, [clinicId]);
    if (savedContract) {
      await pool.query(
        `INSERT INTO compliance_records (clinic_id, kind, status, reference, issuer, valid_from, valid_until, verified_at, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [clinicId, savedContract.kind, savedContract.status, savedContract.reference, savedContract.issuer,
          savedContract.valid_from, savedContract.valid_until, savedContract.verified_at, savedContract.note],
      );
    }
  }
  const left = await pool.query(
    `SELECT (SELECT count(*) FROM leads WHERE name LIKE $1)::int AS leads,
            (SELECT count(*) FROM branches WHERE name LIKE $1)::int AS branches,
            (SELECT count(*) FROM doctors WHERE name LIKE $1)::int AS doctors`,
    [`${TAG}%`],
  );
  const r = left.rows[0];
  console.log(`\ntemizlik: kalan satır → lead ${r.leads}, şube ${r.branches}, doktor ${r.doctors}`);
  if (r.leads || r.branches || r.doctors) failed++;
  await pool.end();
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
