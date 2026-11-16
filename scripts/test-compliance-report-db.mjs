// Aylık Uyum Raporu — GERÇEK veritabanı. Run: npm run check:compliance-report-db
//   (dev DB: node -r dotenv/config scripts/test-compliance-report-db.mjs dotenv_config_path=.env.local)
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { getDefaultClinicId, getComplianceReportRaw, getComplianceReport } from '../src/store/repository.js';
import { getClinicMonthWindow } from '../src/services/complianceReport.js';
import { renderComplianceReportPdf } from '../src/services/pdf.js';
import { getProfile } from '../src/services/profile.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
const TAG = `ZZCR-${Date.now()}`;
const ids = [];

try {
  const clinicId = await getDefaultClinicId();
  const { monthStart, monthEnd } = getClinicMonthWindow(new Date(), -1); // geçen ay — testin de yazacağı pencere

  console.log('▶ Kurulum: geçen ay içine düşen gerçek satırlar');
  {
    const mid = new Date((monthStart.getTime() + monthEnd.getTime()) / 2).toISOString();
    const night = new Date(monthStart.getTime() + 2 * 3600_000).toISOString(); // ayın başı, TSİ gece yarısına yakın

    for (const [lang, n] of [['tr', 3], ['de', 2]]) {
      for (let i = 0; i < n; i++) {
        const lead = (await pool.query(
          `INSERT INTO leads (clinic_id, phone, name, language, status, created_at)
           VALUES ($1,$2,$3,$4,'hot',$5) RETURNING id`,
          [clinicId, `${TAG}-${lang}-${i}`, `${TAG} ${lang}${i}`, lang, mid],
        )).rows[0];
        ids.push(['leads', lead.id]);
        const conv = (await pool.query(
          `INSERT INTO conversations (clinic_id, lead_id) VALUES ($1,$2) RETURNING id`,
          [clinicId, lead.id],
        )).rows[0];
        await pool.query(
          `INSERT INTO messages (conversation_id, role, content, created_at) VALUES
             ($1,'user','merhaba',$2), ($1,'assistant','merhaba',$3)`,
          [conv.id, mid, new Date(new Date(mid).getTime() + 30_000).toISOString()],
        );
        // Bir tanesi gece saatinde — conversations.lead_id TEKİL (bir
        // lead'in tek konuşması olur), o yüzden ikinci bir konuşma
        // AÇMIYORUZ; aynı konuşmaya gece saatli bir mesaj daha ekliyoruz.
        if (i === 0) {
          await pool.query(
            `INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1,'user','gece mesajı',$2)`,
            [conv.id, night],
          );
        }
      }
    }
    const postOpLead = ids.find(([t]) => t === 'leads')[1];
    await pool.query(
      `INSERT INTO post_op_tasks (clinic_id, lead_id, kind, due_at, status) VALUES
        ($1,$2,'checkin',$3,'sent'), ($1,$2,'checkin',$3,'pending')`,
      [clinicId, postOpLead, mid],
    );
  }

  console.log('\n▶ Ham veri gerçekten geçen aydan toplanıyor');
  {
    const raw = await getComplianceReportRaw({ monthStart: monthStart.toISOString(), monthEnd: monthEnd.toISOString() });
    const trRow = raw.messagesByLanguage.find((r) => r.language === 'tr');
    const deRow = raw.messagesByLanguage.find((r) => r.language === 'de');
    check('tr dilinde en az eklediğimiz kadar mesaj var', trRow && trRow.count >= 3, trRow);
    check('de dilinde en az eklediğimiz kadar mesaj var', deRow && deRow.count >= 2, deRow);
    check('gece mesajı sayıldı', raw.nightMessages >= 2, raw.nightMessages);
    check('post-op: 1 vadesi gelmiş-tamamlanmış, 1 bekleyen (payda dışı)', raw.postOpDue >= 1, raw);
  }

  console.log('\n▶ getComplianceReport(): tam birleşim, ay etiketi doğru');
  {
    const report = await getComplianceReport({ monthsAgo: 1 });
    check('month etiketi YYYY-MM biçiminde', /^\d{4}-\d{2}$/.test(report.month), report.month);
    check('messages_by_language dolu', report.messages_by_language.length > 0);
    check('toplam mesaj sayısı tutarlı (alt toplamların toplamı)',
      report.total_messages === report.messages_by_language.reduce((s, r) => s + r.count, 0));
    check('follow_up_rate 0-100 arasında ya da null', report.follow_up_rate === null
      || (report.follow_up_rate >= 0 && report.follow_up_rate <= 100), report.follow_up_rate);
  }

  console.log('\n▶ PDF gerçekten üretiliyor (Chromium, gerçek dosya)');
  {
    // DÜRÜSTLÜK NOTU: bu adım, bu ortamda (konteyner Node'u macOS'un
    // Mach-O Chrome ikilisini spawn edemiyor — ENOEXEC) çalıştırılamadı.
    // Aynı kısıt, bu kod yazılmadan önce de var olan renderQuotePdf()
    // için de geçerli — benim yazdığım koddan kaynaklanmıyor. HTML
    // çıktısının kendisi ayrı bir geçici-export turuyla statik olarak
    // doğrulandı (dengeli etiketler, doğru değerler, boş durum metni);
    // gerçek PDF render'ı ancak gerçek Chrome bulunan bir makinede
    // (kullanıcının kendi ortamı) doğrulanabilir.
    let pdf = null;
    let renderError = null;
    try {
      const profile = await getProfile();
      const report = await getComplianceReport({ monthsAgo: 1 });
      pdf = await renderComplianceReportPdf({ clinic: profile, report, lang: 'tr' });
    } catch (e) {
      renderError = e;
    }
    if (renderError && renderError.code === 'ENOEXEC') {
      console.log('  ⚠ ATLANDI: bu ortamda Chrome spawn edilemiyor (ENOEXEC) — ortam kısıtı, kod hatası değil.');
      console.log('    Gerçek PDF render doğrulaması, Chrome\'un çalıştığı bir makinede npm run check:compliance-report-db ile yapılmalı.');
    } else if (renderError) {
      throw renderError;
    } else {
      check('PDF bir Buffer', Buffer.isBuffer(pdf));
      check('PDF imzası %PDF ile başlıyor', pdf.slice(0, 5).toString() === '%PDF-', pdf.slice(0, 8).toString());
      check('PDF boyutu makul (>1KB, boş sayfa değil)', pdf.length > 1000, pdf.length);
    }
  }
} finally {
  for (const [table, id] of ids) await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]).catch(() => {});
  const left = (await pool.query(`SELECT count(*)::int n FROM leads WHERE name LIKE $1`, [`${TAG}%`])).rows[0].n;
  console.log(`\ntemizlik: kalan lead ${left}`);
  if (left) failed++;
  const { closePdfBrowser } = await import('../src/services/pdf.js');
  await closePdfBrowser().catch(() => {});
  await pool.end();
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
