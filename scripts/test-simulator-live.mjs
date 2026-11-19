// Panel simülatörü — GERÇEK AI + GERÇEK DB uçtan uca kontrol. Ücretli (birkaç
// AI çağrısı). Run: npm run check:simulator  (ANTHROPIC_API_KEY + DATABASE_URL gerekir)
//
// Simülatörün WhatsApp ile aynı boru hattından geçtiğini kanıtlar: cevap
// hastanın dilinde mi, lead skoru/dili/tedavisi DB'ye yazıldı mı, acil
// durumda konuşma devir kuyruğuna ACİL düştü mü. Sonunda test lead'lerini siler.
import crypto from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { runSimulatorTurn } from '../src/routes/webhook.js';
import { getSimulatorSnapshot } from '../src/store/repository.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
const sessions = [];
const newSession = () => { const s = `test-${crypto.randomUUID()}`; sessions.push(s); return s; };

try {
  console.log('▶ Almanca fiyat sorusu');
  {
    const sid = newSession();
    const t0 = Date.now();
    const { reply, leadId } = await runSimulatorTurn({ sessionId: sid, name: 'SIM-TEST', userText: 'Guten Tag, was kosten Veneers bei Ihnen? Ich möchte im März kommen.' });
    console.log(`    (${((Date.now() - t0) / 1000).toFixed(1)} sn) AI: ${String(reply).slice(0, 140)}…`);
    const s = await getSimulatorSnapshot(leadId);
    check('cevap geldi', Boolean(reply));
    check('dil "de" olarak kaydedildi', s?.language === 'de', s?.language);
    check('lead skoru yazıldı', Number.isInteger(s?.score), s?.score);
    check('tedavi ilgisi yazıldı', Boolean(s?.treatment_interest), s?.treatment_interest);
    check('acil DEĞİL', s?.urgent === false, s);
  }

  console.log('\n▶ Arapça ameliyat sonrası kanama (acil)');
  {
    const sid = newSession();
    const t0 = Date.now();
    const { reply, leadId } = await runSimulatorTurn({ sessionId: sid, name: 'SIM-TEST', userText: 'عندي نزيف بعد العملية، أحتاج مساعدة الآن' });
    console.log(`    (${((Date.now() - t0) / 1000).toFixed(1)} sn) AI: ${String(reply).slice(0, 140)}…`);
    const s = await getSimulatorSnapshot(leadId);
    check('cevap Arapça harflerle', /[؀-ۿ]/.test(reply || ''));
    check('konuşma devir kuyruğunda (needs_human)', s?.conversation_status === 'needs_human', s?.conversation_status);
    check('ACİL işaretli', s?.urgent === true, s?.urgent);
    check('tıbbi not dolu', Boolean(s?.medical_note), s?.medical_note);
    check('lead source = simulator', (await pool.query('SELECT source FROM leads WHERE id=$1', [leadId])).rows[0]?.source === 'simulator');
  }
} finally {
  const del = await pool.query(`DELETE FROM leads WHERE source='simulator' AND external_id = ANY($1)`, [sessions]);
  const left = await pool.query(`SELECT count(*)::int n FROM leads WHERE source='simulator' AND external_id = ANY($1)`, [sessions]);
  console.log(`\ntemizlik: ${del.rowCount} test lead silindi, kalan ${left.rows[0].n}`);
  await pool.end();
}
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
