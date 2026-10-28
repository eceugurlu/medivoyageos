// Meta CAPI kuyruğu — GERÇEK veritabanı. DATABASE_URL gerekir.
// Run: npm run check:capi-db
//   (dev DB'ye karşı: node -r dotenv/config scripts/test-capi-db.mjs dotenv_config_path=.env.local)
//
// Asıl soru: aynı ödeme iki kez bildirilirse Meta'ya iki Purchase gider mi?
// Giderse kliniğin ROAS'ı şişer ve bütçesini yanlış yere kaydırır.
import 'dotenv/config';

// CAPI anahtarlarını import'tan ÖNCE kuruyoruz: config.js modül yüklenirken
// okunuyor, yani statik import kullanılsaydı zamanlayıcı turu her zaman
// "yapılandırılmamış" yolundan geçer ve asıl mantık hiç test edilmezdi.
process.env.META_CAPI_DATASET_ID = 'DS_TEST';
process.env.META_CAPI_ACCESS_TOKEN = 'TOKEN_TEST';
process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'WABA_TEST';

const { pool } = await import('../src/db/pool.js');
const {
  getDefaultClinicId, enqueueConversionEvent, claimPendingConversionEvents,
  markConversionEventResult, expireExhaustedConversionEvents, getConversionEventStats,
  updatePayment,
} = await import('../src/store/repository.js');
const { processConversionEvents } = await import('../src/services/scheduler.js');

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

const TAG = `ZZCAPI-${Date.now()}`;
let branchId = null;
const leadIds = [];
// Tura katılmasınlar diye geçici olarak kenara çekilen YABANCI satırlar.
// Durumları değiştirilmez; yalnızca attempts tavana çekilir ve geri alınır.
let parkedAttempts = [];

try {
  const clinicId = await getDefaultClinicId();
  branchId = (await pool.query(
    `INSERT INTO branches (clinic_id, name, city) VALUES ($1,$2,'Test') RETURNING id`,
    [clinicId, `${TAG}-branch`],
  )).rows[0].id;

  // Reklamdan gelen hasta (ctwa_clid var) ve widget'tan gelen hasta (yok).
  for (const [suffix, source, clid] of [['ad', 'whatsapp', `${TAG}-CLID`], ['web', 'widget', null]]) {
    const { rows } = await pool.query(
      `INSERT INTO leads (clinic_id, phone, name, branch_id, source, ctwa_clid)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [clinicId, `${TAG}-${suffix}`, `${TAG} ${suffix}`, branchId, source, clid],
    );
    leadIds.push(rows[0].id);
  }
  const [adLead, webLead] = leadIds;

  console.log('▶ Tekilleştirme: aynı ödeme iki kez Purchase üretemez');
  {
    const first = await enqueueConversionEvent({
      leadId: adLead, eventName: 'Purchase', dedupKey: `${TAG}:purchase:p1`, value: 2500, currency: 'EUR',
    });
    check('ilk yazım satır üretti', Boolean(first));
    const second = await enqueueConversionEvent({
      leadId: adLead, eventName: 'Purchase', dedupKey: `${TAG}:purchase:p1`, value: 2500, currency: 'EUR',
    });
    check('ikinci yazım null döner (zaten kuyrukta)', second === null, second);
    const n = (await pool.query(
      `SELECT count(*)::int n FROM conversion_events WHERE dedup_key = $1`, [`${TAG}:purchase:p1`],
    )).rows[0].n;
    check('veritabanında TEK satır var', n === 1, n);
  }

  console.log('\n▶ Gerçek ödeme akışı: elle "ödendi" iki kez işaretlense de tek olay');
  {
    const payment = (await pool.query(
      `INSERT INTO payments (clinic_id, lead_id, amount, currency, type, status)
       VALUES ($1,$2,1800,'EUR','deposit','pending') RETURNING id`,
      [clinicId, adLead],
    )).rows[0];
    await updatePayment(payment.id, { status: 'paid' });
    await updatePayment(payment.id, { status: 'paid' }); // ikinci kez: idempotent olmalı
    const rows = (await pool.query(
      `SELECT event_name, value, currency, status FROM conversion_events WHERE dedup_key = $1`,
      [`purchase:${payment.id}`],
    )).rows;
    check('tek Purchase satırı', rows.length === 1, rows.length);
    check('tutar ve para birimi ödemeden alındı',
      rows[0] && Number(rows[0].value) === 1800 && rows[0].currency === 'EUR', rows[0]);
    check('durum pending (gönderim zamanlayıcının işi)', rows[0] && rows[0].status === 'pending');
    await pool.query(`DELETE FROM conversion_events WHERE dedup_key = $1`, [`purchase:${payment.id}`]);
    await pool.query(`DELETE FROM payments WHERE id = $1`, [payment.id]);
  }

  console.log('\n▶ Claim: deneme sayacı artar, lead verisi birlikte gelir');
  {
    const claimed = await claimPendingConversionEvents(50, 4);
    const mine = claimed.find((c) => c.lead_id === adLead);
    check('kuyruktan alındı', Boolean(mine));
    check('deneme sayacı 1 oldu', mine && mine.attempts === 1, mine && mine.attempts);
    check('lead verisi JOIN ile geldi (ayrı sorgu yok)',
      mine && mine.lead && mine.lead.ctwa_clid === `${TAG}-CLID` && mine.lead.source === 'whatsapp', mine && mine.lead);

    // Aynı satır ikinci kez alınamaz mı? Hayır — alınabilir, çünkü hâlâ
    // 'pending'. Asıl koruma SKIP LOCKED'ın eşzamanlı turlarda çalışması;
    // burada test edilen, sayacın gerçekten artıp sonsuz döngüyü kesmesi.
    const again = await claimPendingConversionEvents(50, 4);
    const mine2 = again.find((c) => c.id === mine.id);
    check('tekrar alındığında sayaç 2', mine2 && mine2.attempts === 2, mine2 && mine2.attempts);
  }

  console.log('\n▶ Sonuç işaretleme ve deneme hakkının bitmesi');
  {
    const id = (await pool.query(
      `SELECT id FROM conversion_events WHERE dedup_key = $1`, [`${TAG}:purchase:p1`],
    )).rows[0].id;
    const sent = await markConversionEventResult(id, {
      status: 'sent', payload: { event_name: 'Purchase' }, channel: 'whatsapp',
    });
    check("'sent' işaretlendi", sent.status === 'sent');
    const row = (await pool.query(
      `SELECT sent_at, payload, channel FROM conversion_events WHERE id = $1`, [id],
    )).rows[0];
    check('sent_at dolduruldu', row.sent_at !== null);
    check('gönderilen payload saklandı (4xx ayıklaması için tek kanıt)',
      row.payload && row.payload.event_name === 'Purchase', row.payload);
    check('kanal kaydedildi', row.channel === 'whatsapp');

    // Deneme hakkı dolmuş ama hâlâ 'pending' duran satır sonsuza kadar
    // "beklemede" görünmemeli.
    const stuck = await enqueueConversionEvent({
      leadId: adLead, eventName: 'LeadSubmitted', dedupKey: `${TAG}:stuck`,
    });
    await pool.query(`UPDATE conversion_events SET attempts = 9 WHERE id = $1`, [stuck]);
    const expired = await expireExhaustedConversionEvents(4);
    check('tükenmiş satır failed yapıldı', expired >= 1, expired);
    const after = (await pool.query(
      `SELECT status, last_error FROM conversion_events WHERE id = $1`, [stuck],
    )).rows[0];
    check("durumu 'failed'", after.status === 'failed', after.status);
    check('nedeni yazıldı', /deneme hakkı/.test(after.last_error || ''), after.last_error);
  }

  console.log('\n▶ İstatistik: atlanan olayların NEDENLERİ görünür');
  {
    const skipped = await enqueueConversionEvent({
      leadId: webLead, eventName: 'Purchase', dedupKey: `${TAG}:web`, value: 900, currency: 'EUR',
    });
    await markConversionEventResult(skipped, {
      status: 'skipped', skipReason: 'kanal "widget" Meta mesajlaşma kanalı değil',
    });
    const st = await getConversionEventStats({ branchId });
    check('gönderilen sayısı', st.sent === 1, st);
    check('atlanan sayısı', st.skipped === 1, st);
    check('başarısız sayısı', st.failed === 1, st);
    check('atlama nedeni listelendi',
      st.skip_reasons.some((r) => /widget/.test(r.skip_reason)), st.skip_reasons);
    check('son olaylar listesi hasta adını taşıyor',
      st.recent.length >= 3 && st.recent.every((r) => r.lead_name && r.lead_name.startsWith(TAG)), st.recent.length);
    check('gönderilen Purchase değeri toplanmış', st.sent_purchase_value === 2500, st.sent_purchase_value);
    check('yapılandırma durumu raporlanıyor', typeof st.configured === 'boolean');
  }

  console.log('\n▶ Zamanlayıcının tam turu (fetch stub, Meta\'ya çıkılmıyor)');
  {
    // Kuyruğu temizle, sonra iki olay koy: biri gönderilebilir (reklamdan
    // gelen hasta), biri gönderilemez (widget). Tur ikisini AYRI işlemeli.
    await pool.query(`DELETE FROM conversion_events WHERE dedup_key LIKE $1`, [`${TAG}%`]);
    // Bu teste ait olmayan bekleyen satırlar turu kirletmemeli. Onları
    // 'sent' yapmak EN KÖTÜ çözümdü: gerçek bir ortamda hiç gönderilmemiş
    // dönüşümleri gönderilmiş gösterirdi ve test, ölçtüğü sistemi bozardı.
    // Bunun yerine deneme sayacını geçici olarak tavana çekip turun dışında
    // bırakıyoruz; durumlarına dokunulmuyor ve finally'de geri alınıyor.
    parkedAttempts = (await pool.query(
      `SELECT id, attempts FROM conversion_events WHERE status = 'pending' AND dedup_key NOT LIKE $1`,
      [`${TAG}%`],
    )).rows;
    if (parkedAttempts.length) {
      await pool.query(`UPDATE conversion_events SET attempts = 9999 WHERE id = ANY($1::uuid[])`,
        [parkedAttempts.map((r) => r.id)]);
    }
    await enqueueConversionEvent({ leadId: adLead, eventName: 'Purchase', dedupKey: `${TAG}:flush:ok`, value: 3000, currency: 'EUR' });
    await enqueueConversionEvent({ leadId: webLead, eventName: 'Purchase', dedupKey: `${TAG}:flush:no`, value: 900, currency: 'EUR' });

    let sentBodies = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      sentBodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => '{"events_received":1}' };
    };
    const res = await processConversionEvents();
    globalThis.fetch = realFetch;

    check('tur 1 olay gönderdi', res.sent === 1, res);
    check('tur 1 olayı atladı', res.skipped === 1, res);
    check('Meta\'ya TEK istek gidildi (grup halinde)', sentBodies.length === 1, sentBodies.length);
    check('gönderilen olay reklamdan gelen hasta',
      sentBodies[0] && sentBodies[0].data[0].user_data.ctwa_clid === `${TAG}-CLID`, sentBodies[0]?.data[0]?.user_data);
    check('widget hastası hiç gönderilmedi', sentBodies[0] && sentBodies[0].data.length === 1);

    const rows = (await pool.query(
      `SELECT dedup_key, status, skip_reason, attempts FROM conversion_events
        WHERE dedup_key LIKE $1 ORDER BY dedup_key`, [`${TAG}:flush%`],
    )).rows;
    const ok = rows.find((r) => r.dedup_key.endsWith(':ok'));
    const no = rows.find((r) => r.dedup_key.endsWith(':no'));
    check("gönderilen 'sent' oldu", ok.status === 'sent', ok);
    check("gönderilemeyen 'skipped' oldu", no.status === 'skipped', no);
    check('atlama nedeni yazıldı', /Meta mesajlaşma kanalı değil/.test(no.skip_reason || ''), no.skip_reason);
    // Atlanan olay ağa hiç çıkmadı; bir deneme hakkı harcaması anlamsız olurdu
    // ama claim sayacı yine de artar — önemli olan tekrar denenmemesi.
    check('atlanan olay artık pending değil (sonsuz döngü yok)', no.status !== 'pending');
  }

  console.log('\n▶ Kalıcı hata: grup reddedilince tek tek denenir');
  {
    await pool.query(`DELETE FROM conversion_events WHERE dedup_key LIKE $1`, [`${TAG}:iso%`]);
    await enqueueConversionEvent({ leadId: adLead, eventName: 'LeadSubmitted', dedupKey: `${TAG}:iso:1` });
    await enqueueConversionEvent({ leadId: adLead, eventName: 'QualifiedLead', dedupKey: `${TAG}:iso:2` });

    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls++;
      const body = JSON.parse(opts.body);
      // Grup (2 olay) reddedilsin; tek tek gönderimde ilki geçsin, ikincisi düşsün.
      if (body.data.length > 1) return { ok: false, status: 400, text: async () => '{"error":"batch bad"}' };
      const bad = body.data[0].event_name === 'QualifiedLead';
      return { ok: !bad, status: bad ? 400 : 200, text: async () => (bad ? '{"error":"that one"}' : '{"ok":1}') };
    };
    const res = await processConversionEvents();
    globalThis.fetch = realFetch;

    check('izolasyon turu çalıştı', res.isolated === true, res);
    check('3 istek: 1 grup + 2 tekil', calls === 3, calls);
    check('geçerli olay kurtarıldı', res.sent === 1, res);
    check('bozuk olay failed', res.failed === 1, res);
    const rows = (await pool.query(
      `SELECT dedup_key, status, last_error FROM conversion_events WHERE dedup_key LIKE $1 ORDER BY dedup_key`,
      [`${TAG}:iso%`],
    )).rows;
    check("iyi satır 'sent'", rows[0].status === 'sent', rows[0]);
    check("bozuk satır 'failed'", rows[1].status === 'failed', rows[1]);
    check('Meta\'nın hata gövdesi saklandı', /that one/.test(rows[1].last_error || ''), rows[1].last_error);
  }

  console.log('\n▶ Geçici hata: kuyrukta kalır, kaybolmaz');
  {
    await pool.query(`DELETE FROM conversion_events WHERE dedup_key LIKE $1`, [`${TAG}:tmp%`]);
    await enqueueConversionEvent({ leadId: adLead, eventName: 'Purchase', dedupKey: `${TAG}:tmp:1`, value: 50, currency: 'EUR' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'service unavailable' });
    const res = await processConversionEvents();
    globalThis.fetch = realFetch;
    check('geçici hatada hiçbir şey gönderilmiş sayılmaz', res.sent === 0, res);
    check('tekrar denenecek olarak raporlanır', res.retrying === 1, res);
    const row = (await pool.query(
      `SELECT status, attempts FROM conversion_events WHERE dedup_key = $1`, [`${TAG}:tmp:1`],
    )).rows[0];
    check("durumu hâlâ 'pending' (5xx kalıcı değil)", row.status === 'pending', row);
    check('deneme sayacı arttı', row.attempts === 1, row);
  }

  console.log('\n▶ Girdi doğrulaması');
  {
    let threw = false;
    try { await enqueueConversionEvent({ leadId: adLead, eventName: 'Purchase' }); } catch { threw = true; }
    check('dedupKey olmadan reddedilir', threw);
    threw = false;
    try { await enqueueConversionEvent({ leadId: adLead, dedupKey: 'x' }); } catch { threw = true; }
    check('eventName olmadan reddedilir', threw);
  }
} finally {
  // Kenara çekilen yabancı satırların deneme sayacını aynen geri koy.
  for (const r of parkedAttempts) {
    await pool.query(`UPDATE conversion_events SET attempts = $2 WHERE id = $1`, [r.id, r.attempts]);
  }
  await pool.query(`DELETE FROM conversion_events WHERE dedup_key LIKE $1`, [`${TAG}%`]);
  for (const id of leadIds) await pool.query(`DELETE FROM leads WHERE id = $1`, [id]);
  if (branchId) await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  const left = (await pool.query(
    `SELECT (SELECT count(*) FROM conversion_events WHERE dedup_key LIKE $1)::int AS ev,
            (SELECT count(*) FROM leads WHERE name LIKE $1)::int AS leads,
            (SELECT count(*) FROM branches WHERE name LIKE $1)::int AS branches`,
    [`${TAG}%`],
  )).rows[0];
  const stranded = (await pool.query(
    `SELECT count(*)::int n FROM conversion_events WHERE attempts = 9999`,
  )).rows[0].n;
  console.log(`\ntemizlik: kalan → olay ${left.ev}, lead ${left.leads}, şube ${left.branches}; kenarda kalan satır ${stranded}`);
  if (stranded) failed++;
  if (left.ev || left.leads || left.branches) failed++;
  await pool.end();
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
