// Sonuç Pasaportu — GERÇEK veritabanı. Run: npm run check:passport
//   (dev DB: node -r dotenv/config scripts/test-passport.mjs dotenv_config_path=.env.local)
//
// Asıl soru: yarım doldurulmuş ya da geri çekilmiş bir kayıt, yabancı bir
// acil servisin eline geçebilir mi? Geçemezse bu dosya onu kanıtlar.
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import {
  getDefaultClinicId, getPassportForLead, upsertPassport,
  issuePassport, revokePassport, getPassportByToken,
} from '../src/store/repository.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

const TAG = `ZZPP-${Date.now()}`;
let leadId = null; let doctorId = null;

try {
  const clinicId = await getDefaultClinicId();
  doctorId = (await pool.query(
    `INSERT INTO doctors (clinic_id, name, specialty, api_token) VALUES ($1,$2,'Plastik Cerrahi',$3) RETURNING id`,
    [clinicId, `${TAG}-dr`, `${TAG}-tok`],
  )).rows[0].id;
  leadId = (await pool.query(
    `INSERT INTO leads (clinic_id, phone, name, country, language, doctor_id)
     VALUES ($1,$2,$3,'DE','de',$4) RETURNING id`,
    [clinicId, `${TAG}-p`, `${TAG} Patient`, doctorId],
  )).rows[0].id;

  console.log('▶ Taslak: kaydedilir ama YAYINLANMAZ');
  {
    check('pasaport yokken null döner', (await getPassportForLead(leadId)) === null);
    const draft = await upsertPassport(leadId, {
      procedure_name: 'FUE saç ekimi', procedure_date: '2026-09-20', anesthesia: 'Lokal',
      implants: [{ type: 'Greft', brand: '—', lot: 'LOT-77', side: 'donör: oksipital' }],
      medications: [{ name: 'Amoksisilin', dose: '500mg', duration: '7 gün' }],
      aftercare: 'İlk 3 gün yıkama yok.', warning_signs: '38° üstü ateş.',
      emergency_contact: '+90 555 000 00 00', content_language: 'tr',
    });
    check('taslak yazıldı', Boolean(draft));
    check('issued_at boş (henüz yayında değil)', draft.issued_at === null, draft.issued_at);
    check('token üretildi', typeof draft.view_token === 'string' && draft.view_token.length === 32, draft.view_token);
    // ASIL TEST: token var ama kayıt yayınlanmadı → kamu ucu BULMAMALI.
    check('YAYINLANMAMIŞ pasaport token ile bulunamaz',
      (await getPassportByToken(draft.view_token)) === null);
    check('tarih metin olarak döner', draft.procedure_date === '2026-09-20', draft.procedure_date);
    check('implant JSONB olarak saklandı', Array.isArray(draft.implants) && draft.implants[0].lot === 'LOT-77', draft.implants);
  }

  console.log('\n▶ Yayınlama ön koşulu: işlem adı ve tarih olmadan olmaz');
  {
    const token = (await getPassportForLead(leadId)).view_token;
    await upsertPassport(leadId, { procedure_name: '', procedure_date: '2026-09-20' });
    let threw = null;
    try { await issuePassport(leadId); } catch (e) { threw = e.message; }
    check('işlem adı boşken yayınlanmaz', /procedure name and date/.test(threw || ''), threw);
    check('hâlâ kamuya kapalı', (await getPassportByToken(token)) === null);

    await upsertPassport(leadId, { procedure_name: 'FUE saç ekimi', procedure_date: null });
    threw = null;
    try { await issuePassport(leadId); } catch (e) { threw = e.message; }
    check('tarih boşken yayınlanmaz', /procedure name and date/.test(threw || ''), threw);

    // Bozuk tarih de "tarih yok" sayılır (isoDateOrNull) — 500 değil, 400.
    await upsertPassport(leadId, { procedure_name: 'FUE saç ekimi', procedure_date: 'yakında' });
    threw = null;
    try { await issuePassport(leadId); } catch (e) { threw = e.message; }
    check('bozuk tarih yayınlamayı engeller, patlatmaz', /procedure name and date/.test(threw || ''), threw);

    let noneThrew = null;
    try { await issuePassport('00000000-0000-4000-8000-000000000000'); } catch (e) { noneThrew = e.message; }
    check('olmayan pasaport için ayrı hata', /passport not found/.test(noneThrew || ''), noneThrew);
  }

  console.log('\n▶ Yayınlandıktan sonra: hekimin gördüğü kayıt');
  {
    await upsertPassport(leadId, {
      procedure_name: 'FUE saç ekimi', procedure_date: '2026-09-20', anesthesia: 'Lokal',
      implants: [{ type: 'Greft', lot: 'LOT-77' }],
      medications: [{ name: 'Amoksisilin', dose: '500mg', duration: '7 gün' }],
      warning_signs: '38° üstü ateş.', emergency_contact: '+90 555 000 00 00',
      content_language: 'tr',
    });
    const issued = await issuePassport(leadId);
    check('issued_at dolduruldu', issued.issued_at !== null);
    const pub = await getPassportByToken(issued.view_token);
    check('kamu ucu artık buluyor', Boolean(pub));
    check('hasta adı var', pub.patient_name === `${TAG} Patient`);
    check('cerrah adı ve branşı JOIN ile geldi',
      pub.doctor_name === `${TAG}-dr` && pub.doctor_specialty === 'Plastik Cerrahi', pub);
    check('klinik adı var', Boolean(pub.clinic_name));
    check('lot numarası taşınıyor (recall kontrolünün dayandığı alan)',
      pub.implants[0].lot === 'LOT-77', pub.implants);
    check('referans kodu token\'ın ilk 8 hanesi, BÜYÜK harf',
      pub.reference === issued.view_token.slice(0, 8).toUpperCase(), pub.reference);
    check('metin dili işaretli (çeviri yok, etiket var)', pub.content_language === 'tr');
    check('hastanın dili ayrı alanda', pub.patient_language === 'de');

    // leads.outcome_status BİLEREK dışarıda: klinik içi bir değerlendirme,
    // hastanın elindeki belgede resmi teşhis gibi görünmemeli.
    await pool.query(`UPDATE leads SET outcome_status='complication' WHERE id=$1`, [leadId]);
    const again = await getPassportByToken(issued.view_token);
    check('klinik içi sonuç değerlendirmesi belgeye SIZMAZ',
      !('outcome_status' in again), Object.keys(again).filter((k) => /outcome/.test(k)));
  }

  console.log('\n▶ Geri çekme: link anında ölür');
  {
    const token = (await getPassportForLead(leadId)).view_token;
    check('geri çekmeden önce canlı', Boolean(await getPassportByToken(token)));
    const rev = await revokePassport(leadId);
    check('revoked_at dolduruldu', rev.revoked_at !== null);
    check('link artık bulunamıyor', (await getPassportByToken(token)) === null);
    let threw = null;
    try { await revokePassport(leadId); } catch (e) { threw = e.message; }
    check('ikinci kez geri çekilemez', /no live passport/.test(threw || ''), threw);

    // Yeniden yayınlama geri çekmeyi temizler ve AYNI token'ı korur:
    // hastanın eline geçmiş link tekrar çalışsın, yeni bir kod ezberlemesin.
    const re = await issuePassport(leadId);
    check('yeniden yayınlanınca revoked_at temizlendi', re.revoked_at === null);
    check('token değişmedi', re.view_token === token, re.view_token);
    check('link tekrar çalışıyor', Boolean(await getPassportByToken(token)));
  }

  console.log('\n▶ Girdi temizliği: panelden gelen biçimsiz veri sayfayı bozamaz');
  {
    const messy = await upsertPassport(leadId, {
      procedure_name: 'X', procedure_date: '2026-01-02',
      implants: [
        { type: 'İyi', lot: 'OK-1' },
        { type: '', brand: '', lot: '' },                 // tamamen boş → düşmeli
        { type: 'Z', evil: 'drop table', lot: 'OK-2' },   // bilinmeyen anahtar → düşmeli
        'bir metin',                                       // nesne değil → düşmeli
        null,
      ],
      medications: [{ name: 'A'.repeat(400), dose: '1' }],
    });
    // 5 girdiden 2'si hayatta kalır: tamamen boş satır, düz metin ve null
    // düşer. Hangi 2'si olduğunu da yazıyoruz ki sayı değişirse neden
    // değiştiği belli olsun.
    check('5 girdiden 2 geçerli satır kaldı', messy.implants.length === 2, messy.implants);
    check('kalanlar doğru satırlar', messy.implants.map((r) => r.lot).join(',') === 'OK-1,OK-2', messy.implants);
    check('bilinmeyen anahtar ayıklandı', !('evil' in messy.implants[1]), messy.implants[1]);
    check('bilinen anahtarlar korundu', messy.implants[1].type === 'Z' && messy.implants[1].lot === 'OK-2');
    check('aşırı uzun değer 200 karaktere kırpıldı', messy.medications[0].name.length === 200, messy.medications[0].name.length);

    const huge = await upsertPassport(leadId, {
      procedure_name: 'X', procedure_date: '2026-01-02',
      implants: Array.from({ length: 50 }, (_, i) => ({ type: `t${i}` })),
    });
    check('satır sayısı 20 ile sınırlı', huge.implants.length === 20, huge.implants.length);

    const notArray = await upsertPassport(leadId, { procedure_name: 'X', procedure_date: '2026-01-02', implants: 'hiç' });
    check('dizi olmayan girdi boş diziye düşer', Array.isArray(notArray.implants) && notArray.implants.length === 0);
  }

  console.log('\n▶ Tekillik: hasta başına tek pasaport');
  {
    const n = (await pool.query(`SELECT count(*)::int n FROM passports WHERE lead_id = $1`, [leadId])).rows[0].n;
    check('defalarca upsert edilse de tek satır', n === 1, n);
  }
} finally {
  if (leadId) await pool.query(`DELETE FROM leads WHERE id = $1`, [leadId]); // passports CASCADE
  if (doctorId) await pool.query(`DELETE FROM doctors WHERE id = $1`, [doctorId]);
  const left = (await pool.query(
    `SELECT (SELECT count(*) FROM leads WHERE name LIKE $1)::int AS leads,
            (SELECT count(*) FROM doctors WHERE name LIKE $1)::int AS doctors,
            (SELECT count(*) FROM passports p JOIN leads l ON l.id=p.lead_id WHERE l.name LIKE $1)::int AS pp`,
    [`${TAG}%`],
  )).rows[0];
  console.log(`\ntemizlik: kalan → lead ${left.leads}, doktor ${left.doctors}, pasaport ${left.pp}`);
  if (left.leads || left.doctors || left.pp) failed++;
  await pool.end();
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
