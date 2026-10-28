// Meta Conversions API — payload kurulumu ve gönderim davranışı.
// Ağ yok (fetch stub'lanır), DB yok, anahtar yok. Run: npm run check:capi
//
// Bu paketin asıl işi: Meta'nın dokümanından okunan alan adlarının bir daha
// hafızadan "düzeltilmemesini" sağlamak. ctwa_clid'in hash'lenmemesi gibi.
process.env.META_CAPI_DATASET_ID = 'DS_TEST';
process.env.META_CAPI_ACCESS_TOKEN = 'TOKEN_TEST';
process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'WABA_1';
process.env.META_PAGE_ID = 'PAGE_1';
process.env.META_IG_BUSINESS_ACCOUNT_ID = 'IG_1';

const {
  buildMessagingEvent, messagingChannelFor, isCapiConfigured, isPermanentFailure,
  sendEvents, CAPI_GRAPH_VERSION, CAPI_BATCH_SIZE, PARTNER_AGENT,
} = await import('../src/services/metaCapi.js');

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

const waLead = { source: 'whatsapp', ctwa_clid: 'CLID_ABC', external_id: null };

console.log('▶ Meta spec: alan adları dokümandan, hafızadan değil');
{
  const r = buildMessagingEvent({ eventName: 'Purchase', eventTime: '2026-10-28T10:00:00Z', lead: waLead, value: 2500, currency: 'eur' });
  check('olay kuruldu', r.ok, r.reason);
  const e = r.event;
  check('action_source = business_messaging', e.action_source === 'business_messaging', e.action_source);
  check('messaging_channel = whatsapp', e.messaging_channel === 'whatsapp');
  check('user_data.whatsapp_business_account_id dolu', e.user_data.whatsapp_business_account_id === 'WABA_1');
  // Bu testin tek varlık sebebi: biri "kişisel veri, hash'leyelim" diye
  // ctwa_clid'i SHA-256'ya sokarsa eşleşme sessizce sıfırlanır ve panel
  // "gönderildi" yazmaya devam eder. Meta dokümanı: yalnızca em/ph hash'lenir.
  check('ctwa_clid HAM gider (hash YOK)', e.user_data.ctwa_clid === 'CLID_ABC', e.user_data.ctwa_clid);
  check('ctwa_clid 64 haneli hex DEĞİL', !/^[0-9a-f]{64}$/i.test(e.user_data.ctwa_clid));
  // Sabit yazmak yerine hesaplıyoruz: elle yazılmış bir epoch'un yanlış
  // yılda olduğunu fark etmek, testin kendisinin hata kaynağı olması demek.
  const expectedEpoch = Math.floor(Date.parse('2026-10-28T10:00:00Z') / 1000);
  check('event_time SANİYE (ms değil)', e.event_time === expectedEpoch, { got: e.event_time, want: expectedEpoch });
  check('event_time 10 haneli', String(e.event_time).length === 10);
  check('event_time geri çevrilince aynı ana denk gelir',
    new Date(e.event_time * 1000).toISOString() === '2026-10-28T10:00:00.000Z');
  check('custom_data.value sayı', e.custom_data.value === 2500);
  check('para birimi büyük harfe çevrildi', e.custom_data.currency === 'EUR');
  check('graph sürümü v26.0 (Business Messaging referansı)', CAPI_GRAPH_VERSION === 'v26.0', CAPI_GRAPH_VERSION);
}

console.log('\n▶ Kanal başına kimlik alanları');
{
  const mess = buildMessagingEvent({ eventName: 'LeadSubmitted', lead: { source: 'messenger', external_id: 'PSID_9' } });
  check('messenger → page_id + page_scoped_user_id',
    mess.ok && mess.event.user_data.page_id === 'PAGE_1' && mess.event.user_data.page_scoped_user_id === 'PSID_9', mess);
  check('messenger kaydında ctwa_clid YOK', mess.ok && !('ctwa_clid' in mess.event.user_data));

  const ig = buildMessagingEvent({ eventName: 'LeadSubmitted', lead: { source: 'instagram', external_id: 'IGSID_3' } });
  check('instagram → instagram_business_account_id + ig_sid',
    ig.ok && ig.event.user_data.instagram_business_account_id === 'IG_1' && ig.event.user_data.ig_sid === 'IGSID_3', ig);

  check('messagingChannelFor: facebook → messenger', messagingChannelFor({ source: 'facebook' }) === 'messenger');
  check('messagingChannelFor: WhatsApp büyük/küçük harf', messagingChannelFor({ source: 'WhatsApp' }) === 'whatsapp');
  check('messagingChannelFor: widget → null', messagingChannelFor({ source: 'widget' }) === null);
}

console.log('\n▶ Kurulamayan olay NEDENİYLE reddedilir, sessizce null değil');
{
  const cases = [
    [{ eventName: 'Purchase', lead: { source: 'widget' } }, /Meta mesajlaşma kanalı değil/],
    [{ eventName: 'Purchase', lead: { source: 'whatsapp' } }, /ctwa_clid yok/],
    [{ eventName: 'Purchase', lead: { source: 'messenger' } }, /page-scoped user id/],
    [{ eventName: 'Purchase', lead: null }, /lead bulunamadı/],
    [{ lead: waLead }, /event_name eksik/],
  ];
  for (const [input, re] of cases) {
    const r = buildMessagingEvent(input);
    check(`reddedildi + neden: ${re.source}`, !r.ok && re.test(r.reason), r.reason);
  }
  check('hiçbir ret durumunda exception atılmıyor', true);
}

console.log('\n▶ Değersiz olaylar (lead) custom_data taşımaz');
{
  const r = buildMessagingEvent({ eventName: 'LeadSubmitted', lead: waLead });
  check('LeadSubmitted custom_data içermez', r.ok && !('custom_data' in r.event));
  const bad = buildMessagingEvent({ eventName: 'Purchase', lead: waLead, value: 'çok para' });
  check('sayı olmayan değer custom_data üretmez', bad.ok && !('custom_data' in bad.event));
}

console.log('\n▶ Gönderim: istek şekli ve hata sınıflandırması');
{
  check('yapılandırma algılandı', isCapiConfigured());
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '{"events_received":1}' };
  };
  const ev = buildMessagingEvent({ eventName: 'Purchase', lead: waLead, value: 10 }).event;
  const res = await sendEvents([ev]);
  check('2xx → ok', res.ok && res.status === 200);
  check('URL /{dataset}/events', captured.url === `https://graph.facebook.com/${CAPI_GRAPH_VERSION}/DS_TEST/events`, captured.url);
  check('Bearer token başlıkta', captured.opts.headers.Authorization === 'Bearer TOKEN_TEST');
  const body = JSON.parse(captured.opts.body);
  check('gövde { data: [...] }', Array.isArray(body.data) && body.data.length === 1);
  check('partner_agent gönderildi', body.partner_agent === PARTNER_AGENT, body.partner_agent);
  // Doğrulanamadığı için bilerek göndermediğimiz alan. Meta'nın Business
  // Messaging referansında geçmiyor; yalnızca otomatik-olay akışında var.
  check('messaging_outcome_data GÖNDERİLMİYOR (referansta yok)', !('messaging_outcome_data' in body.data[0]));
  check('test_event_code yoksa gövdeye eklenmez', !('test_event_code' in body));

  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"Invalid parameter"}}' });
  const bad = await sendEvents([ev]);
  check('4xx → ok:false', !bad.ok && bad.status === 400);
  check('hata gövdesi saklanıyor (Meta ayrıntı vermiyor, elimizdeki tek ipucu)', /Invalid parameter/.test(bad.body));
  check('4xx kalıcı sayılır', isPermanentFailure(400) && isPermanentFailure(404));
  check('5xx kalıcı DEĞİL (tekrar denenir)', !isPermanentFailure(500) && !isPermanentFailure(503));
  check('ağ hatası (status null) kalıcı değil', !isPermanentFailure(null));

  globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const to = await sendEvents([ev]);
  check('zaman aşımı yakalanır, atmaz', !to.ok && to.error === 'zaman aşımı', to);

  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const net = await sendEvents([ev]);
  check('ağ hatası yakalanır', !net.ok && /ECONNRESET/.test(net.error));
}

console.log('\n▶ Grup boyutu Vercel bütçesine göre seçilmiş');
{
  // Kalıcı hatada izolasyon turu tek tek gönderir: CAPI_BATCH_SIZE × 1.5sn
  // zaman aşımı, 30sn'lik fonksiyon bütçesini aşmamalı.
  check(`izolasyon turu en kötü hâlde ${CAPI_BATCH_SIZE * 1.5}sn < 30sn`, CAPI_BATCH_SIZE * 1.5 < 30, CAPI_BATCH_SIZE);
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
