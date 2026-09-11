// seed-demo-ops.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Panelin KPI'ları artık uydurma sabitler değil, veritabanından hesaplanıyor:
// AI özerkliği, cihaz doluluğu ve danışman dönüşüm oranı gerçek satırlardan
// geliyor. Bu da demo için bir sorun yaratır — veri yoksa hepsi 0 görünür.
//
// Bu script o boşluğu DOĞRU yoldan doldurur: sahte bir yüzde yazmak yerine,
// panelin kendi formüllerinin üzerinde çalışacağı gerçekçi operasyon verisi
// üretir (dil, koordinatör ataması, bugünün randevuları, kapanmış vakalar).
//
// Sunucu çalışırken veya kapalıyken çalıştırılabilir:
//     node seed-demo-ops.mjs
//
// Önce `node seed-demo.mjs` ile konuşmaların oluşturulmuş olması gerekir.
// Tekrar çalıştırmak güvenlidir: bugünün randevularını silip yeniden kurar.
// ─────────────────────────────────────────────────────────────────────────────

import { pool, dbEnabled } from './src/db/pool.js';
import { getDefaultClinicId, assignCoordinatorByLanguage } from './src/store/repository.js';

if (!dbEnabled) {
  console.error('DATABASE_URL ayarlı değil — bu script veritabanı olmadan çalışamaz.');
  process.exit(1);
}

// Demo konuşmalarının kim olduğu. AI açıkken bu alanları concierge kendisi
// çıkarır; kredi yokken elle veriyoruz ki alt sistemler test edilebilsin.
const PROFILES = [
  { phone: '491771111111', language: 'de', country: 'Germany',        treatment: 'Hair transplant (FUE)', budget: '€2.500–3.500', score: 82, lead: 'booked',      conv: 'ai_handling' },
  { phone: '971502222222', language: 'ar', country: 'UAE',            treatment: 'Hair transplant',        budget: '€3.000',        score: 76, lead: 'hot',         conv: 'ai_handling' },
  { phone: '447703333333', language: 'en', country: 'United Kingdom', treatment: 'Revision surgery',       budget: null,            score: 41, lead: 'handed_over', conv: 'needs_human' },
  { phone: '33612345678',  language: 'fr', country: 'France',         treatment: 'Dental veneers',         budget: '€4.000–5.000',  score: 68, lead: 'hot',         conv: 'human_handling' },
];

// Cihaz başına bugün kaç slot dolsun. repository.js'teki SLOTS_PER_DAY = 6, yani
// bunlar sırasıyla %83 / %67 / %50 / %33 doluluk demek — ortalama %58.
const BOOKINGS_PER_DEVICE = [5, 4, 3, 2];

async function main() {
  const clinicId = await getDefaultClinicId();
  console.log('\n📋  Demo operasyon verisi kuruluyor…\n');

  // ── 1. Lead profilleri ────────────────────────────────────────────────────
  let updated = 0;
  for (const p of PROFILES) {
    const r = await pool.query(
      `UPDATE leads
          SET language = $2, country = $3, treatment_interest = $4,
              budget_hint = $5, score = $6, status = $7, updated_at = now()
        WHERE phone = $1
      RETURNING id, name`,
      [p.phone, p.language, p.country, p.treatment, p.budget, p.score, p.lead],
    );
    if (!r.rows[0]) {
      console.log(`  ⚠  ${p.phone} bulunamadı — önce "node seed-demo.mjs" çalıştır.`);
      continue;
    }
    updated++;
    console.log(`  ✓ ${r.rows[0].name} → ${p.language.toUpperCase()} · ${p.country} · skor ${p.score} · ${p.lead}`);

    // Konuşma durumu: AI özerkliği bu alandan hesaplanıyor.
    await pool.query(
      `UPDATE conversations SET status = $2, updated_at = now()
        WHERE lead_id = $1`,
      [r.rows[0].id, p.conv],
    );

    // Koordinatör ataması için GERÇEK üretim yolunu çağır — böylece demo,
    // dil eşleştirme mantığını da sınamış olur.
    const coordId = await assignCoordinatorByLanguage(r.rows[0].id, p.language);
    if (coordId) {
      const c = await pool.query('SELECT name FROM coordinators WHERE id = $1', [coordId]);
      console.log(`      koordinatör: ${c.rows[0]?.name ?? coordId}`);
    } else {
      console.log('      koordinatör: eşleşme yok (AI köprü kuruyor)');
    }
  }

  if (!updated) {
    console.log('\nHiç lead güncellenmedi. Çıkılıyor.\n');
    return;
  }

  // ── 1b. Yanıtsız bir hasta mesajı ────────────────────────────────────────
  // Panelin "Yanıt bekliyor" filtresi son mesajın hastadan gelmesine bakar.
  // Demoda o durumun da görünmesi için bir hastaya son sözü veriyoruz.
  const waiting = await pool.query(
    `SELECT c.id FROM conversations c JOIN leads l ON l.id = c.lead_id
      WHERE l.phone = $1`,
    [PROFILES[0].phone],
  );
  if (waiting.rows[0]) {
    const convId = waiting.rows[0].id;
    const last = await pool.query(
      `SELECT role FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [convId],
    );
    if (last.rows[0]?.role !== 'user') {
      await pool.query(
        `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
        [convId, 'Vielen Dank! Können Sie mir noch sagen, wie viele Tage ich in Istanbul bleiben muss?'],
      );
      console.log('\n  ✓ bir hasta yanıt bekliyor (Gelen Kutusu filtresi için)');
    }
  }

  // ── 2. Bugünün randevuları ────────────────────────────────────────────────
  const devices = await pool.query(
    'SELECT id, name FROM devices WHERE active ORDER BY name',
  );
  const leads = await pool.query('SELECT id FROM leads ORDER BY created_at');

  // Tekrar çalıştırmaya karşı: bu scriptin bugün için kurduklarını temizle.
  const wiped = await pool.query(
    `DELETE FROM appointments WHERE starts_at::date = now()::date`,
  );
  if (wiped.rowCount) console.log(`\n  (bugün için ${wiped.rowCount} eski randevu temizlendi)`);

  console.log('');
  let slot = 0;
  for (const [i, d] of devices.rows.entries()) {
    const count = BOOKINGS_PER_DEVICE[i % BOOKINGS_PER_DEVICE.length];
    for (let j = 0; j < count; j++) {
      // Klinik günü 09:00'da başlasın, her slot 1 saat.
      const start = `date_trunc('day', now()) + interval '${9 + j} hours'`;
      await pool.query(
        `INSERT INTO appointments (clinic_id, device_id, lead_id, starts_at, ends_at, status)
         VALUES ($1, $2, $3, ${start}, ${start} + interval '1 hour', 'booked')`,
        [clinicId, d.id, leads.rows[slot % leads.rows.length]?.id ?? null],
      );
      slot++;
    }
    console.log(`  ✓ ${d.name} → bugün ${count}/6 slot dolu (%${Math.round((count / 6) * 100)})`);
  }

  // ── 3. Özet ───────────────────────────────────────────────────────────────
  const check = await pool.query(`
    SELECT
      (SELECT count(*) FROM conversations WHERE status = 'ai_handling')   AS ai,
      (SELECT count(*) FROM conversations)                                AS total,
      (SELECT count(*) FROM leads WHERE status = 'booked')                AS booked,
      (SELECT count(*) FROM appointments WHERE starts_at::date = now()::date) AS appts
  `);
  const r = check.rows[0];
  console.log(`\n  Panelin artık hesaplayacağı gerçek değerler:`);
  console.log(`    AI özerkliği   : ${Math.round((r.ai / r.total) * 100)}%  (${r.ai}/${r.total} görüşme insansız)`);
  console.log(`    Bugünkü randevu: ${r.appts}`);
  console.log(`    Rezervasyonlu  : ${r.booked} lead`);
  console.log(`\nBitti. Paneli yenile: http://localhost:3000/panel\n`);
}

main()
  .catch((err) => {
    console.error('\n✗ Hata:', err.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
