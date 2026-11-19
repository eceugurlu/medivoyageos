// AI Asistan (koordinatör için) — GERÇEK AI + GERÇEK DB. Ücretli (~6 AI çağrısı).
// Run: npm run check:assist   (ANTHROPIC_API_KEY + DATABASE_URL gerekir)
// Saf yardımcılar (extractJson, buildTranscript) ayrıca DB'siz test edilir.
import crypto from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { getClinicIdForTest } from './_assistTestHelpers.mjs';
import { summarizeConversation, suggestReply, rewriteText, extractJson, buildTranscript } from '../src/services/agentAssist.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

console.log('▶ Saf yardımcılar');
check('extractJson: kod çitli JSON', extractJson('```json\n{"a":1}\n```')?.a === 1);
check('extractJson: önsözlü JSON', extractJson('Tabii: {"a":2} bitti')?.a === 2);
check('extractJson: bozuk → null', extractJson('{"a":') === null && extractJson('merhaba') === null);
const tr = buildTranscript([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: '[template: x] hello' }, { role: 'assistant', content: 'Hello!' }]);
check('buildTranscript: şablon mesajı çıkarıldı, roller doğru', tr === 'HASTA: Hi\nKLİNİK: Hello!', tr);

const sid = `test-assist-${crypto.randomUUID()}`;
const clinicId = await getClinicIdForTest(pool);
const leadId = (await pool.query(
  `INSERT INTO leads (clinic_id, external_id, source, name, language, treatment_interest, score)
   VALUES ($1,$2,'simulator','ASSIST-TEST','de','Veneers',55) RETURNING id`, [clinicId, sid])).rows[0].id;
try {
  const convId = (await pool.query(`INSERT INTO conversations (clinic_id, lead_id) VALUES ($1,$2) RETURNING id`, [clinicId, leadId])).rows[0].id;
  const msgs = [
    ['user', 'Guten Tag, was kosten Veneers bei Ihnen? Ich möchte im März kommen.'],
    ['assistant', 'Guten Tag! Veneers kosten ca. 180–250 € pro Zahn. Haben Sie ein aktuelles Foto Ihrer Zähne?'],
    ['user', 'Ja, ich schicke es morgen. Können Sie mir auch ein Hotel empfehlen? Ich brauche 6 Zähne.'],
  ];
  for (const [role, content] of msgs) await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1,$2,$3)`, [convId, role, content]);
  const detail = { lead: { name: 'ASSIST-TEST', language: 'de', treatment_interest: 'Veneers', score: 55 }, messages: msgs.map(([role, content]) => ({ role, content })) };

  console.log('\n▶ Özet + görev önerisi (Almanca konuşma → Türkçe özet)');
  const b = await summarizeConversation(detail);
  console.log('    özet:', b.summary.join(' | ').slice(0, 220));
  console.log('    görevler:', b.tasks.map((t) => t.title).join(' | '));
  check('1-5 özet maddesi', b.summary.length >= 1 && b.summary.length <= 5, b.summary.length);
  check('özet Türkçe (Türkçe harf/sözcük)', /[çğıöşüÇĞİÖŞÜ]|hasta|istiyor|veneer/i.test(b.summary.join(' ')), b.summary);
  check('özet konuşmadaki bilgiyi içeriyor (6 diş / mart)', /6|altı/.test(b.summary.join(' ')) || /mart/i.test(b.summary.join(' ')), b.summary);
  check('1-4 görev, hepsinin başlığı dolu', b.tasks.length >= 1 && b.tasks.length <= 4 && b.tasks.every((t) => t.title), b.tasks);
  check('kullanım bilgisi döndü', Number.isFinite(b.usage?.input_tokens));

  console.log('\n▶ Yanıt taslağı (Almanca hasta → Almanca taslak + Türkçe çeviri)');
  const d = await suggestReply(detail);
  console.log('    taslak:', d.reply.slice(0, 200).replace(/\n/g, ' '));
  console.log('    çeviri:', d.translation_tr.slice(0, 160).replace(/\n/g, ' '));
  check('taslak Almanca (Almanca sözcük işaretleri)', /\b(Sie|Ihre|Ihr|und|für|gerne|ein|Hotel)\b/.test(d.reply), d.reply.slice(0, 80));
  check('Türkçe çeviri dolu ve Türkçe', d.translation_tr.length > 10 && /[çğıöşüÇĞİÖŞÜ]|ve |bir /.test(d.translation_tr), d.translation_tr.slice(0, 80));
  check('taslak bir bağlantı/ödeme linki vaat etmiyor (http yok)', !/https?:\/\//i.test(d.reply), d.reply);

  console.log('\n▶ Son mesaj KLİNİKTEN olsa da taslak 4/4 kez okunabilir (düşünme tokenleri JSON\'u kesmesin) ve uydurma yok');
  const tail = [...detail.messages.slice(0, 2), { role: 'assistant', content: 'Danke! Für ein genaues Angebot bräuchten wir ein aktuelles Foto Ihrer Zähne. Möchten Sie eines senden?' }];
  let ok = 0; const invented = [];
  for (let i = 0; i < 4; i++) {
    try {
      const r = await suggestReply({ lead: detail.lead, messages: tail });
      ok++;
      if (/Wochen|begrenzt|Plätze|Vorlaufzeit|limited|slots|weeks|%|Rabatt/i.test(r.reply)) invented.push(r.reply);
    } catch (err) { console.log('    hata:', err.message); }
  }
  check('4/4 taslak okunabildi', ok === 4, ok);
  check('uydurma kıtlık/süre/indirim iddiası yok', invented.length === 0, invented);

  console.log('\n▶ Acil durumda taslak güvenli mi (Arapça kanama)');
  const e = await suggestReply({ lead: { language: 'ar' }, messages: [{ role: 'user', content: 'عندي نزيف بعد العملية، أحتاج مساعدة الآن' }] });
  console.log('    taslak:', e.reply.slice(0, 160).replace(/\n/g, ' '));
  check('Arapça taslak', /[؀-ۿ]/.test(e.reply));
  check('satış/fiyat konuşmuyor (€ yok)', !/€|EUR|يورو/.test(e.reply), e.reply);
  const eb = await summarizeConversation({ lead: { language: 'ar' }, messages: [{ role: 'user', content: 'عندي نزيف بعد العملية، أحتاج مساعدة الآن' }] });
  check('ilk görev acil/tıbbi yönlendirme', /acil|tıbbi|doktor|hemen|kanama|komplikasyon/i.test(eb.tasks[0]?.title + ' ' + eb.tasks[0]?.why), eb.tasks[0]);

  console.log('\n▶ Metin düzenleme: yeni bilgi UYDURMUYOR');
  const orig = 'Guten Tag, die Behandlung kostet 200 € pro Zahn. Wir melden uns morgen.';
  for (const mode of ['warmer', 'shorter', 'professional', 'fix']) {
    const r = await rewriteText({ text: orig, mode });
    check(`${mode}: "200" korundu, link/yeni sayı yok`, /200/.test(r.text) && !/https?:\/\//.test(r.text) && (r.text.match(/\d+/g) || []).every((n) => n === '200'), r.text);
  }
  const t = await rewriteText({ text: 'Wir melden uns morgen bei Ihnen.', mode: 'translate', targetLanguage: 'Arabic' });
  check('translate: Arapça çıktı', /[؀-ۿ]/.test(t.text), t.text);
  let threw = false; try { await rewriteText({ text: 'x', mode: 'nope' }); } catch (err) { threw = err.status === 400; }
  check('bilinmeyen mod → 400', threw);
  threw = false; try { await rewriteText({ text: '   ', mode: 'fix' }); } catch (err) { threw = err.status === 400; }
  check('boş metin → 400', threw);
} finally {
  const del = await pool.query(`DELETE FROM leads WHERE id=$1`, [leadId]);
  const left = (await pool.query(`SELECT count(*)::int n FROM leads WHERE external_id=$1`, [sid])).rows[0].n;
  console.log(`\ntemizlik: ${del.rowCount} test lead silindi, kalan ${left}`);
  await pool.end();
}
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
