// seed-demo.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Paneli test etmek için yerel webhook'a birkaç örnek hasta mesajı gönderir.
// Sunucu çalışırken (npm run dev) AYRI bir sekmede:  node seed-demo.mjs
//
// AI açıksa gerçek çok dilli yanıtlar üretilir ve panelde görünür.
// Not: Demo numaralara WhatsApp gönderimi Meta tarafında başarısız olabilir
// (bu numaralar sana hiç yazmadığı için) — bu beklenen bir durum, zararsızdır;
// panel/DB/AI tarafı yine de çalışır. Gerçek teslimat için kendi numaranla yaz.
// ─────────────────────────────────────────────────────────────────────────────

const URL = process.env.WEBHOOK_URL || 'http://localhost:3000/webhook';

const samples = [
  { name: 'Hans Müller', wa: '491771111111', id: 'seed_de',
    text: 'Guten Tag, ich interessiere mich für eine Haartransplantation. Was kostet das ungefähr?' },
  { name: 'Layla Ahmed', wa: '971502222222', id: 'seed_ar',
    text: 'مرحبا، أريد حجز موعد لزراعة الشعر الأسبوع القادم. ميزانيتي حوالي 3000 يورو' },
  { name: 'John Smith', wa: '447703333333', id: 'seed_en',
    text: 'I am very unhappy — my previous clinic ruined my results and nobody replies to me!' },
  { name: 'Sophie Martin', wa: '33612345678', id: 'seed_fr',
    text: 'Bonjour, je voudrais des facettes dentaires. Quel est le prix et comment réserver ?' },
];

function payload(s) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ profile: { name: s.name }, wa_id: s.wa }],
      messages: [{ from: s.wa, id: 'wamid.' + s.id + '_' + Date.now(), type: 'text', text: { body: s.text } }],
    } }] }],
  };
}

console.log(`\nSeeding ${samples.length} demo conversations → ${URL}\n`);
for (const s of samples) {
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload(s)),
    });
    console.log(`  ${res.status === 200 ? '✓' : '✗'} ${s.name} (${s.wa})`);
  } catch (e) {
    console.error(`  ✗ ${s.name}: ${e.message} — sunucu çalışıyor mu?`);
  }
  await new Promise((r) => setTimeout(r, 1500)); // AI yanıtlarına zaman tanı
}
console.log('\nBitti. Paneli aç: http://localhost:3000/panel\n');
