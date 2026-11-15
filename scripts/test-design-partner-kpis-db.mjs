// Tasarım Ortağı KPI — GERÇEK veritabanı. Run: npm run check:dp-kpis-db
//   (dev DB: node -r dotenv/config scripts/test-design-partner-kpis-db.mjs dotenv_config_path=.env.local)
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import {
  getDefaultClinicId, setDesignPartnerGoal, listDesignPartnerGoals,
  getCurrentKpiMeasurements, getDesignPartnerKpiReport,
} from '../src/store/repository.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
let savedGoals = [];

try {
  const clinicId = await getDefaultClinicId();
  savedGoals = await listDesignPartnerGoals();

  console.log('▶ Hedef yazma ve okuma');
  {
    const g = await setDesignPartnerGoal('response_time_seconds', {
      baseline_value: 14400, target_value: 90, baseline_date: '2026-11-01', note: 'Pilot başlangıcı',
    });
    check('hedef yazıldı', g.metric === 'response_time_seconds' && Number(g.baseline_value) === 14400);
    check('tarih metin olarak döner', g.baseline_date === '2026-11-01', g.baseline_date);

    const again = await setDesignPartnerGoal('response_time_seconds', { baseline_value: 10000, target_value: 60 });
    check('aynı metrik ikinci kez yazılınca güncellenir, çoğalmaz', Number(again.baseline_value) === 10000);
    const rows = await listDesignPartnerGoals();
    check('tek satır kaldı', rows.filter((r) => r.metric === 'response_time_seconds').length === 1);
  }

  console.log('\n▶ Girdi doğrulaması');
  {
    let msg = null;
    try { await setDesignPartnerGoal('uydurma_metrik', { baseline_value: 1, target_value: 2 }); } catch (e) { msg = e.message; }
    check('bilinmeyen metrik reddedilir', /Unknown metric/.test(msg || ''), msg);
    msg = null;
    try { await setDesignPartnerGoal('response_time_seconds', { baseline_value: 'çok', target_value: 60 }); } catch (e) { msg = e.message; }
    check('sayı olmayan baseline reddedilir', /must be a number/.test(msg || ''), msg);
    const cleared = await setDesignPartnerGoal('response_time_seconds', { baseline_value: null, target_value: null });
    check('null ile hedef temizlenebilir', cleared.baseline_value === null && cleared.target_value === null);
  }

  console.log('\n▶ Gerçek ölçüm: panelin başka yerindeki sayıyla AYNI kaynaktan');
  {
    const m = await getCurrentKpiMeasurements();
    check('response_time_seconds sayı veya null (NaN değil)',
      m.response_time_seconds === null || Number.isFinite(m.response_time_seconds), m.response_time_seconds);
    check('appointment_conversion_rate sayı veya null', m.appointment_conversion_rate === null
      || (Number.isFinite(m.appointment_conversion_rate) && m.appointment_conversion_rate >= 0), m.appointment_conversion_rate);
  }

  console.log('\n▶ Tam rapor: hedef + ölçüm birleşiyor');
  {
    await setDesignPartnerGoal('response_time_seconds', { baseline_value: 14400, target_value: 90 });
    await setDesignPartnerGoal('appointment_conversion_rate', { baseline_value: 0.1, target_value: 0.4 });
    const report = await getDesignPartnerKpiReport();
    check('2 metrik de raporda', report.metrics.length === 2, report.metrics.length);
    check('ölçüm zamanı damgalanmış', typeof report.measured_at === 'string');
    const rt = report.metrics.find((m) => m.metric === 'response_time_seconds');
    check('statü no_goal/no_data/on_track/behind/reached\'ten biri',
      ['no_goal', 'no_data', 'on_track', 'behind', 'reached'].includes(rt.status), rt.status);
    check('hiçbir statü patlamadı (undefined yok)', report.metrics.every((m) => m.status != null));
  }
  void clinicId;
} finally {
  await pool.query(`DELETE FROM design_partner_goals WHERE clinic_id = (SELECT id FROM clinics ORDER BY created_at LIMIT 1)`);
  // Testten önceki hedefleri geri koy (varsa) — gerçek pilotun verisini
  // kaybetmeyelim.
  for (const g of savedGoals) {
    await pool.query(
      `INSERT INTO design_partner_goals (clinic_id, metric, baseline_value, target_value, baseline_date, note)
       VALUES ((SELECT id FROM clinics ORDER BY created_at LIMIT 1), $1,$2,$3,$4,$5)
       ON CONFLICT (clinic_id, metric) DO NOTHING`,
      [g.metric, g.baseline_value, g.target_value, g.baseline_date, g.note],
    );
  }
  const left = (await pool.query(`SELECT count(*)::int n FROM design_partner_goals`)).rows[0].n;
  console.log(`\ntemizlik: kalan hedef sayısı ${left} (geri yüklenen: ${savedGoals.length})`);
  if (left !== savedGoals.length) failed++;
  await pool.end();
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
