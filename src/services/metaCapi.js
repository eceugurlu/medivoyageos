// Meta Conversions API — Business Messaging.
//
// Reklamdan ameliyata giden zincirin GERİ dönüşü. Meta, hangi tıklamanın
// gerçekten ödemeye döndüğünü ancak biz söylersek bilir; söylediğimizde
// algoritma reklamı o kitleye optimize eder.
//
// Spec kaynağı: Meta'nın kendi dokümanı (Conversions API for Business
// Messaging). Hafızadan değil, canlı dokümandan alındı:
//   POST https://graph.facebook.com/v26.0/{DATASET_ID}/events
//   body: { data: [event…], partner_agent }
//   event.action_source    = "business_messaging"
//   event.messaging_channel= "whatsapp" | "messenger" | "instagram"
//   WhatsApp + tıklama kimliği → user_data: { whatsapp_business_account_id, ctwa_clid }
//   Messenger                  → user_data: { page_id, page_scoped_user_id }
//   Instagram                  → user_data: { instagram_business_account_id, ig_sid }
//
// ctwa_clid HASH'LENMEZ. Yalnızca müşteri bilgisi parametreleri (em, ph)
// SHA-256 ister; tıklama kimliği bir eşleştirme jetonudur, kişisel veri
// değil. Hash'lemek eşleşmeyi sessizce sıfırlar — yani hiç göndermemekle
// aynı sonucu verir ama panelde "gönderildi" yazar. O yüzden burada açıkça.
//
// DOĞRULANAMAYAN iki nokta, saklanmıyor:
//   - Meta'nın otomatik-olay sayfasındaki `messaging_outcome_data` alanı
//     Business Messaging CAPI referansında GEÇMİYOR. O akış, Meta'nın
//     işletme adına kendi gönderdiği akış; bizimki elle gönderim. Bu yüzden
//     göndermiyoruz. Meta reddederse last_error'da görünür.
//   - Instagram için doküman gövdede `ig_sid` kullanıyor ama metinde IGSID
//     diyor. Instagram zaten CAPI optimizasyonu kapsamında değil (Meta'nın
//     kendi notu), o yüzden bu yol en zayıf halka olarak işaretli.

import { config } from '../config.js';

export const CAPI_GRAPH_VERSION = config.meta.capi.graphVersion;
const SEND_TIMEOUT_MS = 1500; // Meta'nın kendi önerisi
export const PARTNER_AGENT = 'medivoyage-os';

export function isCapiConfigured() {
  const c = config.meta.capi;
  return Boolean(c.datasetId && c.accessToken);
}

/** Lead'in hangi kanaldan geldiğini Meta'nın beklediği değere çevirir. */
export function messagingChannelFor(lead) {
  const src = String(lead && lead.source ? lead.source : '').toLowerCase();
  if (src === 'whatsapp') return 'whatsapp';
  if (src === 'instagram') return 'instagram';
  if (src === 'messenger' || src === 'facebook') return 'messenger';
  return null; // widget, telefon, elle giriş: Meta'ya bildirilecek tıklama yok
}

/**
 * Tek bir olayı kurar. Kuramıyorsa NEDENİNİ döner — sessizce null değil.
 * Saf fonksiyon: config dışında hiçbir yan etkisi yok, ağ yok.
 *
 * @returns {{ok:true, event:object, channel:string}|{ok:false, reason:string}}
 */
export function buildMessagingEvent({ eventName, eventTime, lead, value, currency } = {}) {
  if (!eventName) return { ok: false, reason: 'event_name eksik' };
  if (!lead) return { ok: false, reason: 'lead bulunamadı' };

  const channel = messagingChannelFor(lead);
  if (!channel) {
    return { ok: false, reason: `kanal "${lead.source || 'bilinmiyor'}" Meta mesajlaşma kanalı değil` };
  }

  const ids = config.meta.capi;
  const user_data = {};
  if (channel === 'whatsapp') {
    // Tıklama kimliği olmayan WhatsApp yolu da var (page_id + hash'li em/ph)
    // ama o yol, elimizde olmayan bir page_id istiyor ve dokümana göre
    // page_id'siz olay — geçerli müşteri bilgisi taşısa bile — reddediliyor.
    // Elimizde olmayan bir alanı varmış gibi göndermek yerine atlıyoruz.
    if (!lead.ctwa_clid) return { ok: false, reason: 'ctwa_clid yok — bu hasta reklam tıklamasından gelmemiş' };
    if (!ids.whatsappBusinessAccountId) return { ok: false, reason: 'WHATSAPP_BUSINESS_ACCOUNT_ID ayarlı değil' };
    user_data.whatsapp_business_account_id = ids.whatsappBusinessAccountId;
    user_data.ctwa_clid = lead.ctwa_clid; // hash YOK, bilerek
  } else if (channel === 'messenger') {
    if (!lead.external_id) return { ok: false, reason: 'page-scoped user id (external_id) yok' };
    if (!ids.pageId) return { ok: false, reason: 'META_PAGE_ID ayarlı değil' };
    user_data.page_id = ids.pageId;
    user_data.page_scoped_user_id = lead.external_id;
  } else {
    if (!lead.external_id) return { ok: false, reason: 'IGSID (external_id) yok' };
    if (!ids.instagramBusinessAccountId) return { ok: false, reason: 'META_IG_BUSINESS_ACCOUNT_ID ayarlı değil' };
    user_data.instagram_business_account_id = ids.instagramBusinessAccountId;
    user_data.ig_sid = lead.external_id;
  }

  const event = {
    event_name: eventName,
    // Meta saniye bekliyor, milisaniye değil.
    event_time: Math.floor(new Date(eventTime || Date.now()).getTime() / 1000),
    action_source: 'business_messaging',
    messaging_channel: channel,
    user_data,
  };

  if (value != null && Number.isFinite(Number(value))) {
    event.custom_data = {
      value: Number(value),
      currency: String(currency || 'EUR').toUpperCase().slice(0, 3),
    };
  }
  return { ok: true, event, channel };
}

/**
 * Olayları Meta'ya gönderir. Tek seferde bir grup; Meta grubun tamamına tek
 * bir 2xx/4xx döner, o yüzden grup küçük tutulur (bkz. CAPI_BATCH_SIZE).
 * @returns {{ok:boolean, status:number|null, body:string, error:string|null}}
 */
export async function sendEvents(events) {
  if (!isCapiConfigured()) {
    return { ok: false, status: null, body: '', error: 'CAPI yapılandırılmamış' };
  }
  const c = config.meta.capi;
  const url = `https://graph.facebook.com/${CAPI_GRAPH_VERSION}/${c.datasetId}/events`;
  const body = { data: events, partner_agent: PARTNER_AGENT };
  // Events Manager'ın "Test Events" sekmesine düşürmek için. Canlı veriye
  // karışmaz, o yüzden pilotu kanlı canlı denemeden önce tek yol bu.
  if (c.testEventCode) body.test_event_code = c.testEventCode;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.accessToken}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    // Meta: 2xx = payload geçerli, 4xx = geçersiz (ayrıntı az). 4xx'i
    // tekrar denemek anlamsız; 5xx ve ağ hatası denenebilir.
    return { ok: res.ok, status: res.status, body: text.slice(0, 500), error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, body: '', error: err.name === 'AbortError' ? 'zaman aşımı' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 4xx kalıcıdır: aynı payload tekrar denense yine reddedilir. */
export function isPermanentFailure(status) {
  return typeof status === 'number' && status >= 400 && status < 500;
}

// 10, keyfi değil: kalıcı hata sonrası izolasyon turu en kötü hâlde
// 10 × 1.5s = 15s sürer ve Vercel'in 30s fonksiyon bütçesine sığar.
// 20 olsaydı izolasyon turu fonksiyonu zaman aşımına uğratırdı.
export const CAPI_BATCH_SIZE = 10;
export const CAPI_MAX_ATTEMPTS = 4;
