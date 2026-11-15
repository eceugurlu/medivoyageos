// Sean Ellis PMF — GERÇEK veritabanı. Run: npm run check:pmf-db
//   (dev DB: node -r dotenv/config scripts/test-pmf-survey-db.mjs dotenv_config_path=.env.local)
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { getDefaultClinicId, submitPmfResponse, getPmfSurveyStats } from '../src/store/repository.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
const TAG = `ZZPMF-${Date.now()}`;
const ids = [];
let coordId = null;

try {
  const clinicId = await getDefaultClinicId();
  coordId = (await pool.query(
    `INSERT INTO coordinators (clinic_id, name, languages) VALUES ($1,$2,'{tr,en}') RETURNING id`,
    [clinicId, `${TAG}-coord`],
  )).rows[0].id;

  console.log('▶ Girdi doğrulaması');
  {
    let msg = null;
    try { await submitPmfResponse({ answer: 'belki' }); } catch (e) { msg = e.message; }
    check('bilinmeyen cevap reddedilir', /Unknown answer/.test(msg || ''), msg);
    msg = null;
    try { await submitPmfResponse({ answer: 'very_disappointed', coordinatorId: '00000000-0000-4000-8000-000000000000' }); } catch (e) { msg = e.message; }
    check('olmayan koordinatör reddedilir', /coordinator not found/.test(msg || ''), msg);
  }

  console.log('\n▶ Kayıt — koordinatörlü ve anonim');
  {
    const r1 = await submitPmfResponse({ answer: 'very_disappointed', coordinatorId: coordId, reason: `${TAG} test` });
    ids.push(r1.id);
    check('koordinatörlü cevap yazıldı', Boolean(r1.id));

    const r2 = await submitPmfResponse({ answer: 'somewhat_disappointed' }); // koordinatörsüz
    ids.push(r2.id);
    check('anonim cevap da kabul edilir', Boolean(r2.id));
  }

  console.log('\n▶ İstatistik: gerçek satırlardan toplanıyor');
  {
    for (let i = 0; i < 3; i++) {
      ids.push((await submitPmfResponse({ answer: 'very_disappointed', coordinatorId: coordId })).id);
    }
    const st = await getPmfSurveyStats();
    check('toplam en az eklediğimiz kadar', st.total >= 5, st.total);
    check('very_disappointed sayısı doğru (en az 4)', st.counts.very_disappointed >= 4, st.counts);
    check('örneklem taşıdığı için signal karar veriyor', typeof st.signal === 'boolean' || st.signal === null);
    check('son yanıtlarda koordinatör adı JOIN ile geldi',
      st.recent.some((r) => r.coordinator_name === `${TAG}-coord`), st.recent.map((r) => r.coordinator_name));
    check('anonim yanıtta koordinatör adı null', st.recent.some((r) => r.coordinator_name === null));
    check('neden metni taşınıyor', st.recent.some((r) => r.reason === `${TAG} test`));
  }
} finally {
  for (const id of ids) await pool.query(`DELETE FROM pmf_survey_responses WHERE id = $1`, [id]);
  if (coordId) await pool.query(`DELETE FROM coordinators WHERE id = $1`, [coordId]);
  const left = (await pool.query(
    `SELECT (SELECT count(*) FROM pmf_survey_responses WHERE reason LIKE $1)::int AS r,
            (SELECT count(*) FROM coordinators WHERE name LIKE $1)::int AS c`,
    [`${TAG}%`],
  )).rows[0];
  console.log(`\ntemizlik: kalan → yanıt ${left.r}, koordinatör ${left.c}`);
  if (left.r || left.c) failed++;
  await pool.end();
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
