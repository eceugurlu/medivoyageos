// Kurulum kontrol listesi hesabı — DB yok, ağ yok. Run: npm run check:setup-checklist
import { buildChecklist, STEPS, STEP_KEYS, AUTO_KEYS, MANUAL_KEYS } from '../src/services/setupChecklist.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

console.log('▶ Boş girdi: hiçbir adım tamam değil, patlamaz');
{
  const r = buildChecklist({}, {});
  check('hiçbir adım done değil', r.items.every((i) => i.done === false));
  check('done sayısı 0', r.done === 0);
  check('complete false', r.complete === false);
  check('progress 0', r.progress === 0);
  check(`${STEPS.length} adım var`, r.items.length === STEPS.length);
}

console.log('\n▶ Otomatik adımlar: gerçek sinyalden okunur, satır yazılmaz');
{
  const r = buildChecklist({ clinic_profile: true, whatsapp_connected: true, first_branch: false,
    first_coordinator: true, payment_provider: false }, {});
  const byKey = (k) => r.items.find((i) => i.key === k);
  check('sinyali true olan auto adım done', byKey('clinic_profile').done === true);
  check('sinyali false olan auto adım done değil', byKey('first_branch').done === false);
  check('auto adımların done_at her zaman null (satır yok, zaman damgası da yok)',
    AUTO_KEYS.every((k) => byKey(k).done_at === null));
}

console.log('\n▶ Elle işaretlenen adımlar: yalnızca manualState etkiler');
{
  const r = buildChecklist({}, {
    test_conversation: { done: true, done_at: '2026-11-10T09:00:00Z', note: 'DE dilinde test edildi' },
  });
  const byKey = (k) => r.items.find((i) => i.key === k);
  check('işaretlenen manual adım done', byKey('test_conversation').done === true);
  check('zaman damgası taşınıyor', byKey('test_conversation').done_at === '2026-11-10T09:00:00Z');
  check('not taşınıyor', byKey('test_conversation').note === 'DE dilinde test edildi');
  check('işaretlenmeyen diğer manual adımlar done değil',
    MANUAL_KEYS.filter((k) => k !== 'test_conversation').every((k) => byKey(k).done === false));
}

console.log('\n▶ "Tamamlandı" ancak HEPSİ tamamsa — yuvarlama yok');
{
  const allAuto = Object.fromEntries(AUTO_KEYS.map((k) => [k, true]));
  const allManualButOne = Object.fromEntries(
    MANUAL_KEYS.slice(0, -1).map((k) => [k, { done: true }]),
  );
  const almost = buildChecklist(allAuto, allManualButOne);
  check('bir adım eksikken complete false', almost.complete === false, { done: almost.done, total: almost.total });
  check('progress %100 değil', almost.progress < 100, almost.progress);

  const allManual = Object.fromEntries(MANUAL_KEYS.map((k) => [k, { done: true }]));
  const full = buildChecklist(allAuto, allManual);
  check('hepsi tamamsa complete true', full.complete === true);
  check('progress tam %100', full.progress === 100);
}

console.log('\n▶ Adım tanımları tutarlı');
{
  check('her adımın tekil anahtarı var', new Set(STEP_KEYS).size === STEP_KEYS.length);
  check('auto + manual toplamı tüm adımlara eşit', AUTO_KEYS.length + MANUAL_KEYS.length === STEPS.length);
  check('her adımın bir label ve hint metni var', STEPS.every((s) => s.label && s.hint));
  check('her adımın bir kategorisi var', STEPS.every((s) => typeof s.category === 'string' && s.category.length > 0));
  // Bu, en kritik testlerden biri: güvenlik devrinin test edildiğini
  // doğrulamak İSTEĞE BAĞLI bir madde OLAMAZ — listede var olmalı.
  check("'escalation_tested' adımı listede", STEP_KEYS.includes('escalation_tested'));
}

console.log('\n▶ Dayanıklılık');
{
  for (const bad of [undefined, null, 'metin', 42, []]) {
    let ok = true;
    try { buildChecklist(bad, bad); } catch { ok = false; }
    check(`girdi ${JSON.stringify(bad)} → hata yok`, ok);
  }
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
