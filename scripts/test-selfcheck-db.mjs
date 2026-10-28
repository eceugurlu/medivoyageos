// Ücretsiz Uyum Kontrolü — GERÇEK veritabanı. Run: npm run check:selfcheck-db
//   (dev DB: node -r dotenv/config scripts/test-selfcheck-db.mjs dotenv_config_path=.env.local)
//
// Bu uç KİMLİK DOĞRULAMASIZ. O yüzden testin ağırlığı girdi temizliğinde:
// tanınmayan alanlar, aşırı uzun metin ve bozuk e-posta ne oluyor?
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { saveComplianceCheck, getComplianceCheckStats, listComplianceCheckLeads } from '../src/store/repository.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
const TAG = `ZZSC-${Date.now()}`;
const ids = [];
const save = async (o) => { const r = await saveComplianceCheck(o); ids.push(r.id); return r; };

try {
  console.log('▶ Kayıt ve skor');
  {
    const r = await save({
      clinic_name: `${TAG} Klinik`, city: 'İstanbul',
      answers: {
        health_tourism_authorization: 'valid', accreditation: 'in_progress',
        complication_insurance: 'missing', kvkk_registry: 'valid',
        multilingual_24_7: 'mostly', contact_logs: 'always',
        consent_records: 'always', postop_followup: 'sometimes', outcome_records: 'never',
      },
    });
    check('kayıt yazıldı ve id döndü', Boolean(r.id));
    check('skor hesaplandı', typeof r.score === 'number', r.score);
    check('kapsam 1 (hepsi cevaplandı)', r.coverage === 1, r.coverage);
    check('beyan bayrağı sonuçta', r.declared_only === true);
    check('açıklar listelendi', r.gaps.length >= 2, r.gaps.map((g) => g.id));
    check('akreditasyona kalan gün geldi', Number.isInteger(r.deadlines.accreditation_days));
  }

  console.log('\n▶ Boş anket: 0 puan değil, kayıt yine tutulur');
  {
    const r = await save({ answers: {} });
    check('skor null', r.score === null);
    check('kapsam 0', r.coverage === 0);
    const row = (await pool.query(`SELECT score, coverage, gap_count FROM compliance_checks WHERE id = $1`, [r.id])).rows[0];
    check('veritabanında da score NULL (0 değil)', row.score === null, row);
    check('gap_count yazıldı', row.gap_count === 9, row.gap_count);
  }

  console.log('\n▶ Girdi temizliği (kimlik doğrulamasız uç)');
  {
    const r = await save({
      clinic_name: 'A'.repeat(500),
      city: 'B'.repeat(300),
      answers: {
        accreditation: 'valid',
        accreditation_valid_until: '2028-01-01',
        // Tanınmayan anahtarlar saklanmamalı: kimlik doğrulamasız bir uçta
        // serbest JSON kabul etmek, veritabanını başkasının çöplüğü yapar.
        evil: 'drop table',
        __proto__: 'x',
        not_a_question: 'y',
      },
      source: 'C'.repeat(300),
    });
    const row = (await pool.query(`SELECT clinic_name, city, answers, source FROM compliance_checks WHERE id = $1`, [r.id])).rows[0];
    check('klinik adı 160 karaktere kırpıldı', row.clinic_name.length === 160, row.clinic_name.length);
    check('şehir 80 karaktere kırpıldı', row.city.length === 80, row.city.length);
    check('kaynak 80 karaktere kırpıldı', row.source.length === 80);
    check('tanınmayan anahtarlar atıldı',
      !('evil' in row.answers) && !('not_a_question' in row.answers), Object.keys(row.answers));
    check('tanınan anahtarlar korundu',
      row.answers.accreditation === 'valid' && row.answers.accreditation_valid_until === '2028-01-01', row.answers);
  }

  console.log('\n▶ E-posta: yalnızca geçerliyse saklanır');
  {
    for (const bad of ['deneme', 'a@b', '@yok.com', 'bos @ bos.com', '']) {
      const r = await save({ answers: { kvkk_registry: 'valid' }, email: bad });
      const row = (await pool.query(`SELECT email FROM compliance_checks WHERE id = $1`, [r.id])).rows[0];
      check(`geçersiz e-posta "${bad}" saklanmadı`, row.email === null, row.email);
    }
    const good = await save({ answers: { kvkk_registry: 'valid' }, email: `  ${TAG}@Ornek.COM  ` });
    const row = (await pool.query(`SELECT email FROM compliance_checks WHERE id = $1`, [good.id])).rows[0];
    check('geçerli e-posta kırpılıp küçük harfe çevrildi', row.email === `${TAG.toLowerCase()}@ornek.com`, row.email);
  }

  console.log('\n▶ İstatistik ve satış listesi');
  {
    const st = await getComplianceCheckStats();
    check('toplam sayıldı', st.total >= ids.length, st.total);
    check('e-posta bırakanlar ayrı sayıldı', st.with_email >= 1, st.with_email);
    check('son 7 gün sayıldı', st.last_7d >= ids.length);
    check('ortalama skor sayı veya null', st.avg_score === null || Number.isFinite(st.avg_score), st.avg_score);
    check('son kayıtlar listesi var', Array.isArray(st.recent) && st.recent.length > 0);
    // Özet kutusunda e-posta GÖRÜNMEMELİ: panelde kişisel veriyi yalnızca
    // onu isteyen uç döndürsün.
    check('özette e-posta adresi yok, yalnızca bırakılıp bırakılmadığı',
      st.recent.every((r) => !('email' in r) && 'left_email' in r), Object.keys(st.recent[0]));

    const leads = await listComplianceCheckLeads();
    check('satış listesinde e-posta var', leads.length > 0 && leads.every((l) => l.email));
    check('listede yalnızca e-posta bırakanlar', leads.every((l) => l.email !== null));
  }
} finally {
  for (const id of ids) await pool.query(`DELETE FROM compliance_checks WHERE id = $1`, [id]);
  const left = (await pool.query(
    `SELECT count(*)::int n FROM compliance_checks WHERE clinic_name LIKE $1 OR email LIKE $2`,
    [`${TAG}%`, `${TAG.toLowerCase()}%`],
  )).rows[0].n;
  console.log(`\ntemizlik: kalan kayıt ${left}`);
  if (left) failed++;
  await pool.end();
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
