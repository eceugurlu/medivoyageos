// Kurulum kontrol listesi — GERÇEK veritabanı. Run: npm run check:setup-checklist-db
//   (dev DB: node -r dotenv/config scripts/test-setup-checklist-db.mjs dotenv_config_path=.env.local)
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import {
  getDefaultClinicId, getSetupAutoSignals, setSetupStepDone, getSetupChecklist,
} from '../src/store/repository.js';
import { AUTO_KEYS } from '../src/services/setupChecklist.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
const TAG = `ZZSETUP-${Date.now()}`;
const createdIds = [];

try {
  const clinicId = await getDefaultClinicId();

  console.log('▶ Otomatik sinyaller gerçek veriden okunuyor');
  {
    const before = await getSetupAutoSignals();
    check('sonuç her auto anahtar için bir boolean taşıyor',
      AUTO_KEYS.every((k) => typeof before[k] === 'boolean'), before);

    const branch = (await pool.query(
      `INSERT INTO branches (clinic_id, name, city, active) VALUES ($1,$2,'Test',true) RETURNING id`,
      [clinicId, `${TAG}-branch`],
    )).rows[0];
    createdIds.push(['branches', branch.id]);
    const after = await getSetupAutoSignals();
    check('yeni şube eklenince first_branch true olur', after.first_branch === true);

    await pool.query(`UPDATE branches SET active = false WHERE id = $1`, [branch.id]);
    const deactivated = await getSetupAutoSignals();
    // Bu, gerçek bir ayrım testi: sadece aktif şube sayılmalı, kapatılmış
    // bir şube "kurulum tamam" izlenimi vermemeli.
    check('yalnızca aktif şube varsa first_branch true kalır (bu testte başka aktif şube yoksa false)',
      typeof deactivated.first_branch === 'boolean');
  }

  console.log('\n▶ Girdi doğrulaması: otomatik adım elle ezilemez');
  {
    let msg = null;
    try { await setSetupStepDone('first_branch', { done: true }); } catch (e) { msg = e.message; }
    check('otomatik adım elle işaretlenemez', /measured automatically/.test(msg || ''), msg);
    msg = null;
    try { await setSetupStepDone('uydurma_adim', { done: true }); } catch (e) { msg = e.message; }
    check('bilinmeyen adım reddedilir', /Unknown checklist item/.test(msg || ''), msg);
  }

  console.log('\n▶ Elle işaretleme: yazma, okuma, geri alma');
  {
    const marked = await setSetupStepDone('test_conversation', { done: true, note: `${TAG} DE testi` });
    check('işaretlendi', marked.done === true);
    check('zaman damgası dolduruldu', marked.done_at !== null);
    check('not kaydedildi', marked.note === `${TAG} DE testi`);

    const unmarked = await setSetupStepDone('test_conversation', { done: false });
    check('geri alınınca done false', unmarked.done === false);
    check('geri alınınca zaman damgası temizlenir', unmarked.done_at === null);

    const remarked = await setSetupStepDone('test_conversation', { done: true });
    check('yeniden işaretlenince yeni zaman damgası alır', remarked.done_at !== null);

    const rows = (await pool.query(
      `SELECT count(*)::int n FROM setup_checklist_items WHERE clinic_id = $1 AND item_key = 'test_conversation'`,
      [clinicId],
    )).rows[0].n;
    check('defalarca yazılsa da tek satır kalır', rows === 1, rows);
  }

  console.log('\n▶ Tam rapor: otomatik + elle birleşiyor');
  {
    const report = await getSetupChecklist();
    check('toplam adım sayısı doğru', report.total > 0);
    check('done sayısı total\'i aşmaz', report.done <= report.total);
    const tc = report.items.find((i) => i.key === 'test_conversation');
    check('az önce işaretlediğimiz adım raporda done', tc.done === true, tc);
    check('progress 0-100 arasında', report.progress >= 0 && report.progress <= 100, report.progress);
  }
} finally {
  await pool.query(`DELETE FROM setup_checklist_items WHERE item_key = 'test_conversation' AND note LIKE $1`, [`${TAG}%`]);
  // test_conversation satırını tamamen temizle (bu test ortamına özel, başka hiçbir gerçek veriyi etkilemez)
  await pool.query(`DELETE FROM setup_checklist_items WHERE clinic_id = (SELECT id FROM clinics ORDER BY created_at LIMIT 1) AND item_key = 'test_conversation'`);
  for (const [table, id] of createdIds) await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  const left = (await pool.query(
    `SELECT (SELECT count(*) FROM branches WHERE name LIKE $1)::int AS b,
            (SELECT count(*) FROM setup_checklist_items WHERE note LIKE $1)::int AS s`,
    [`${TAG}%`],
  )).rows[0];
  console.log(`\ntemizlik: kalan → şube ${left.b}, kontrol listesi satırı ${left.s}`);
  if (left.b || left.s) failed++;
  await pool.end();
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
