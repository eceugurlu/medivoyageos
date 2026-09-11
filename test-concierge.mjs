// test-concierge.mjs
// ─────────────────────────────────────────────────────────────
// AI concierge'ü WhatsApp olmadan, lokalde hızlıca test eder.
//
// Kullanım:
//   1) .env dosyasına GEÇERLİ bir anahtar koy:  ANTHROPIC_API_KEY=sk-ant-...
//   2) Bu dosyayı projenin köküne (medi-voyage-backend/) at
//   3) Çalıştır:   node test-concierge.mjs
// ─────────────────────────────────────────────────────────────
import { generateReply } from './src/services/concierge.js';

const samples = [
  { flag: '🇩🇪 DE', text: 'Hallo, wie viel kostet eine Haartransplantation?' },
  { flag: '🇦🇪 AR', text: 'مرحبا، أريد حجز موعد لزراعة الشعر الأسبوع القادم. ميزانيتي 3000 يورو' },
  { flag: '🇷🇺 RU', text: 'Здравствуйте! Сколько стоят виниры на 8 зубов?' },
  { flag: '🇬🇧 EN', text: 'I am very unhappy, my last clinic ruined my results and nobody replies to me!' },
];

console.log('\nAI concierge test ediliyor…\n');

for (const s of samples) {
  try {
    const { reply, meta } = await generateReply({ history: [], userText: s.text });

    // Anahtar yoksa concierge "echo mode"a düşer — kullanıcıyı uyar.
    if (!meta && /echo mode/i.test(reply)) {
      console.log('⚠️  AI KAPALI (echo mode). .env içine geçerli bir ANTHROPIC_API_KEY koyup tekrar dene.\n');
      break;
    }

    console.log('────────────────────────────────────────────────');
    console.log(`${s.flag}  Hasta : ${s.text}`);
    console.log(`💬  Yanıt : ${reply}`);
    if (meta) {
      const h = meta.handover?.needed ? `EVET — ${meta.handover.reason}` : 'hayır';
      console.log(
        `📊  dil=${meta.detected_language}  skor=${meta.lead?.score}  ` +
          `hazırlık=${meta.lead?.readiness}  devir=${h}`,
      );
    }
    console.log('');
  } catch (err) {
    console.error(`❌  ${s.flag} hata:`, err.status || '', err.message);
    if (err.status === 401) {
      console.error(
        '    → ANTHROPIC_API_KEY geçersiz. console.anthropic.com üzerinden yeni bir anahtar üretip .env içine yaz.\n',
      );
      break;
    }
  }
}
