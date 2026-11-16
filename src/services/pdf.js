// PDF generation for patient quotes, via headless Chromium.
//
// Why Chromium instead of a pure-JS PDF library (pdfkit etc.): the clinic's
// own profile lists Arabic among its supported languages, and pdfkit has no
// Arabic contextual shaping — a quote in Arabic would render as disconnected,
// wrong-direction letters, which is worse than not sending one. Chromium's
// text stack (HarfBuzz + ICU bidi) handles RTL and shaping correctly out of
// the box, so quotes are built as HTML and printed to PDF.
//
// Trade-off worth knowing before deploying this for real: puppeteer-core (no
// bundled browser, kept light) needs *some* Chromium-family browser on the
// host. Locally that's whatever CHROME_PATH points to or a detected install;
// most cloud platforms need either `puppeteer` (bundles its own Chromium —
// swap the import and drop executablePath) or a buildpack/Docker layer that
// installs Chrome. See findChromePath() below for the exact search order.

import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

let cachedBrowser = null;
let cachedExecPath = null;

function findChromePath() {
  if (cachedExecPath) return cachedExecPath;
  const candidates = [
    process.env.CHROME_PATH, // explicit override — set this in production
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS dev
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) { cachedExecPath = p; return p; }
  }
  throw new Error(
    'No Chromium-family browser found for PDF generation. Set CHROME_PATH to a ' +
    'Chrome/Chromium executable, or install one of: google-chrome, chromium.',
  );
}

// On Vercel there is no system Chrome to point CHROME_PATH at, so we pull in
// @sparticuz/chromium — a Chromium build packaged to fit inside a serverless
// function — instead. Dynamic import so local/non-Vercel deploys never pay
// for loading it.
async function launchServerlessBrowser() {
  const { default: chromium } = await import('@sparticuz/chromium');
  return puppeteer.launch({
    executablePath: await chromium.executablePath(),
    headless: true,
    args: chromium.args,
  });
}

async function getBrowser() {
  if (cachedBrowser && cachedBrowser.connected) return cachedBrowser;
  cachedBrowser = process.env.VERCEL
    ? await launchServerlessBrowser()
    : await puppeteer.launch({
        executablePath: findChromePath(),
        headless: true,
        args: ['--no-sandbox', '--disable-gpu'],
      });
  return cachedBrowser;
}

// Labels used inside the PDF itself, in every language the clinic serves.
// Falls back to English for anything not listed.
const RTL_LANGS = new Set(['ar', 'fa', 'he', 'ur']);
// contactUs is deliberately channel-neutral — a quote can now be delivered
// over WhatsApp, Instagram, or Messenger (see api.js's /quotes/:id/send),
// and hardcoding "reply on WhatsApp" would send the wrong instruction to a
// patient who messaged in from a different platform.
const LABELS = {
  en: { quote: 'Treatment Quote', item: 'Item', qty: 'Qty', unitPrice: 'Unit price', total: 'Total', validUntil: 'Valid until', preparedFor: 'Prepared for', contactUs: 'Questions? Just reply to this conversation.' },
  tr: { quote: 'Tedavi Teklifi', item: 'Kalem', qty: 'Adet', unitPrice: 'Birim fiyat', total: 'Toplam', validUntil: 'Geçerlilik tarihi', preparedFor: 'Hazırlanan hasta', contactUs: 'Sorularınız için bu sohbetten yazmanız yeterli.' },
  de: { quote: 'Behandlungsangebot', item: 'Position', qty: 'Menge', unitPrice: 'Einzelpreis', total: 'Gesamt', validUntil: 'Gültig bis', preparedFor: 'Erstellt für', contactUs: 'Fragen? Antworten Sie einfach in diesem Chat.' },
  ar: { quote: 'عرض سعر العلاج', item: 'البند', qty: 'الكمية', unitPrice: 'سعر الوحدة', total: 'الإجمالي', validUntil: 'صالح حتى', preparedFor: 'أُعِدّ من أجل', contactUs: 'لديك أسئلة؟ فقط أجب في هذه المحادثة.' },
  ru: { quote: 'Смета лечения', item: 'Позиция', qty: 'Кол-во', unitPrice: 'Цена за ед.', total: 'Итого', validUntil: 'Действительно до', preparedFor: 'Подготовлено для', contactUs: 'Есть вопросы? Просто ответьте в этом чате.' },
  fr: { quote: 'Devis de traitement', item: 'Article', qty: 'Qté', unitPrice: 'Prix unitaire', total: 'Total', validUntil: 'Valable jusqu\'au', preparedFor: 'Préparé pour', contactUs: 'Des questions ? Répondez simplement dans cette conversation.' },
};
function labelsFor(lang) { return LABELS[lang] || LABELS.en; }

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtMoney(amount, currency) {
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount); }
  catch { return `${currency} ${Number(amount).toFixed(2)}`; }
}

// Same fallback chain as the panel's leadIdentity() (public/index.html) —
// an Instagram/Messenger lead has neither a name yet nor a phone, so
// `lead.name || lead.phone` alone renders a blank "Prepared for:" line.
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', widget: 'Web', instagram: 'Instagram', messenger: 'Messenger' };
function leadIdentity(lead) {
  return lead.name || lead.phone || (lead.external_id ? `${CHANNEL_LABEL[lead.source] || 'Chat'} patient` : 'Patient');
}

function buildHtml({ clinic, lead, quote }) {
  const L = labelsFor(quote.language);
  const rtl = RTL_LANGS.has(quote.language);
  const items = Array.isArray(quote.items) ? quote.items : [];
  const validUntil = quote.valid_until
    ? new Date(quote.valid_until).toLocaleDateString(quote.language, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : null;

  return `<!doctype html>
<html lang="${quote.language}" dir="${rtl ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8">
<style>
  /* Same "clinic ledger" system as the panel/widget: cool paper ground, deep
     petrol ink, brass held back for the total — the one figure the patient
     is here to read. System fonts only: this runs in a headless browser with
     no network access, so a web font would silently fail to load. */
  @page { size: A4; margin: 22mm 18mm; }
  *{box-sizing:border-box}
  body{
    margin:0;color:#0c1316;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    font-size:11pt;line-height:1.5;
  }
  .brand{display:flex;align-items:center;gap:10px;border-bottom:2px solid #0c1316;padding-bottom:14px;margin-bottom:22px}
  .mark{width:28px;height:28px;border-radius:3px;background:#0e5750;flex:none}
  .brand-name{font-size:17px;font-weight:700;letter-spacing:-.01em}
  .brand-city{color:#4b555b;font-size:10pt;margin-${rtl ? 'right' : 'left'}:auto}
  h1{font-size:22px;font-weight:700;letter-spacing:-.015em;margin:0 0 4px}
  .meta{color:#4b555b;font-size:10pt;margin-bottom:22px}
  .meta b{color:#0c1316}
  table{width:100%;border-collapse:collapse;margin-bottom:6px}
  th{
    font-size:9pt;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#4b555b;
    text-align:${rtl ? 'right' : 'left'};padding:8px 6px;border-bottom:1px solid #c3ccd1;
  }
  th.num,td.num{text-align:${rtl ? 'left' : 'right'};font-variant-numeric:tabular-nums}
  td{padding:9px 6px;border-bottom:1px solid #dde3e6;font-size:10.5pt}
  tfoot td{border-bottom:0;border-top:2px solid #0c1316;font-weight:700;font-size:13pt;padding-top:12px}
  tfoot td.label{color:#4b555b;font-weight:400;font-size:10pt}
  .total-amount{color:#8c6415}
  .valid{margin-top:22px;padding:12px 14px;background:#e4efed;border:1px solid #9dc3bc;border-${rtl ? 'left' : 'right'}:3px solid #0e5750;font-size:10pt}
  .footer{margin-top:34px;padding-top:14px;border-top:1px solid #dde3e6;color:#7f8a90;font-size:9pt}
</style></head>
<body>
  <div class="brand">
    <div class="mark"></div>
    <div class="brand-name">${escapeHtml(clinic.name)}</div>
    <div class="brand-city">${escapeHtml(clinic.city || '')}</div>
  </div>
  <h1>${L.quote}</h1>
  <div class="meta">${L.preparedFor}: <b>${escapeHtml(leadIdentity(lead))}</b></div>
  <table>
    <thead><tr>
      <th>${L.item}</th><th class="num">${L.qty}</th><th class="num">${L.unitPrice}</th><th class="num">${L.total}</th>
    </tr></thead>
    <tbody>
      ${items.map((it) => `<tr>
        <td>${escapeHtml(it.label)}</td>
        <td class="num">${Number(it.qty ?? 1)}</td>
        <td class="num">${fmtMoney(it.unit_price ?? 0, quote.currency)}</td>
        <td class="num">${fmtMoney((Number(it.qty ?? 1)) * Number(it.unit_price ?? 0), quote.currency)}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot><tr>
      <td class="label" colspan="3">${L.total}</td>
      <td class="num total-amount">${fmtMoney(quote.total_amount, quote.currency)}</td>
    </tr></tfoot>
  </table>
  ${validUntil ? `<div class="valid"><b>${L.validUntil}:</b> ${validUntil}</div>` : ''}
  <div class="footer">${escapeHtml(clinic.name)}${clinic.contact?.website ? ' · ' + escapeHtml(clinic.contact.website) : ''}<br>${L.contactUs}</div>
</body></html>`;
}

// Renders a quote to a PDF Buffer. `clinic` is the profile object from
// services/profile.js (getProfile()); `lead` and `quote` are DB rows.
export async function renderQuotePdf({ clinic, lead, quote }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(buildHtml({ clinic, lead, quote }), { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true });
  } finally {
    await page.close();
  }
}

// Aylık uyum raporu: yönetmeliğin istediği 7/24 çok dilli iletişim ve
// hasta takibi iddiasını tek sayfada kanıta çeviren rapor. Aynı "klinik
// defteri" tasarım dilinin daha sade bir hâli — fatura değil, bir KPI
// özeti, o yüzden ayrı bir buildHtml.
const CR_LABELS = {
  en: { title: 'Monthly Compliance Report', period: 'Period', newLeads: 'New patient inquiries', qualified: 'Qualified leads',
    booked: 'Appointments booked', response: 'Median response time', repliedTurns: 'patient messages answered',
    byLang: 'Messages received by language', byLangCol: 'Language', countCol: 'Messages', shareCol: 'Share',
    followUp: 'Post-op follow-up completion', night: 'Overnight coverage (23:00–07:00)',
    noData: 'No data yet for this period.', footer: 'Generated for the clinic\u2019s own accreditation file — against the International Health Tourism Regulation (Official Gazette 26.04.2025, No. 32882).' },
  tr: { title: 'Aylık Uyum Raporu', period: 'Dönem', newLeads: 'Yeni hasta başvurusu', qualified: 'Nitelikli lead',
    booked: 'Randevuya dönüşen', response: 'Medyan cevap süresi', repliedTurns: 'hasta mesajı cevaplandı',
    byLang: 'Dillere göre gelen mesaj sayısı', byLangCol: 'Dil', countCol: 'Mesaj', shareCol: 'Pay',
    followUp: 'Ameliyat sonrası takip tamamlanma oranı', night: 'Gece kapsamı (23:00–07:00)',
    noData: 'Bu dönem için henüz veri yok.', footer: 'Kliniğin kendi akreditasyon dosyası için üretildi — Uluslararası Sağlık Turizmi Yönetmeliği (26.04.2025 tarihli ve 32882 sayılı Resmî Gazete) karşısında.' },
};
function crLabelsFor(lang) { return CR_LABELS[lang] || CR_LABELS.en; }

function fmtDuration(seconds) {
  if (seconds == null) return '\u2013';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round((seconds / 3600) * 10) / 10}h`;
}

function buildComplianceReportHtml({ clinic, report, lang }) {
  const L = crLabelsFor(lang);
  const rtl = RTL_LANGS.has(lang);
  const byLang = report.messages_by_language || [];

  const row = (label, value, sub) => `<div class="cr-stat">
    <div class="cr-label">${escapeHtml(label)}</div>
    <div class="cr-val">${value}</div>
    ${sub ? `<div class="cr-sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;

  return `<!doctype html>
<html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 20mm 16mm; }
  *{box-sizing:border-box}
  body{margin:0;color:#0c1316;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:10.5pt;line-height:1.5}
  .brand{display:flex;align-items:center;gap:10px;border-bottom:2px solid #0c1316;padding-bottom:12px;margin-bottom:16px}
  .mark{width:24px;height:24px;border-radius:3px;background:#0e5750;flex:none}
  .brand-name{font-size:15px;font-weight:700;letter-spacing:-.01em}
  .brand-city{color:#4b555b;font-size:9.5pt;margin-${rtl ? 'right' : 'left'}:auto}
  h1{font-size:19px;font-weight:700;letter-spacing:-.015em;margin:0 0 3px}
  .period{color:#4b555b;font-size:9.5pt;margin-bottom:18px}
  .cr-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#c3ccd1;border:1px solid #c3ccd1;border-radius:4px;overflow:hidden;margin-bottom:16px}
  .cr-stat{background:#fff;padding:10px 12px}
  .cr-label{font-size:8pt;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#4b555b}
  .cr-val{font-size:18px;font-weight:700;margin-top:5px;font-variant-numeric:tabular-nums}
  .cr-sub{color:#7f8a90;font-size:8pt;margin-top:3px}
  table{width:100%;border-collapse:collapse;margin:8px 0 16px}
  th{font-size:8pt;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#4b555b;text-align:${rtl ? 'right' : 'left'};padding:6px;border-bottom:1px solid #c3ccd1}
  th.num,td.num{text-align:${rtl ? 'left' : 'right'};font-variant-numeric:tabular-nums}
  td{padding:7px 6px;border-bottom:1px solid #dde3e6;font-size:9.5pt}
  .sec-title{font-size:9pt;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:#4b555b;margin:18px 0 6px}
  .empty{color:#7f8a90;font-size:9.5pt;padding:8px 0}
  .footer{margin-top:28px;padding-top:12px;border-top:1px solid #dde3e6;color:#7f8a90;font-size:8.5pt;line-height:1.5}
</style></head>
<body>
  <div class="brand">
    <div class="mark"></div>
    <div class="brand-name">${escapeHtml(clinic.name)}</div>
    <div class="brand-city">${escapeHtml(clinic.city || '')}</div>
  </div>
  <h1>${L.title}</h1>
  <div class="period">${L.period}: ${escapeHtml(report.month)}</div>

  <div class="cr-grid">
    ${row(L.newLeads, report.new_leads)}
    ${row(L.qualified, report.qualified_leads)}
    ${row(L.booked, report.appointments_booked)}
    ${row(L.response, fmtDuration(report.avg_response_seconds), report.replied_turns ? `${report.replied_turns} ${L.repliedTurns}` : null)}
    ${row(L.followUp, report.follow_up_rate == null ? '\u2013' : `${report.follow_up_rate}%`, report.post_op_due ? `${report.post_op_sent}/${report.post_op_due}` : null)}
    ${row(L.night, report.night_coverage_rate == null ? '\u2013' : `${report.night_coverage_rate}%`, report.night_messages ? `${report.night_replied}/${report.night_messages}` : null)}
  </div>

  <div class="sec-title">${L.byLang}</div>
  ${byLang.length === 0 ? `<div class="empty">${L.noData}</div>` : `<table>
    <thead><tr><th>${escapeHtml(L.byLangCol)}</th><th class="num">${escapeHtml(L.countCol)}</th><th class="num">${escapeHtml(L.shareCol)}</th></tr></thead>
    <tbody>
      ${byLang.map((r) => `<tr>
        <td>${escapeHtml(r.language ? r.language.toUpperCase() : '\u2014')}</td>
        <td class="num">${r.count}</td>
        <td class="num">${r.share == null ? '\u2013' : `${r.share}%`}</td>
      </tr>`).join('')}
    </tbody>
  </table>`}

  <div class="footer">${escapeHtml(clinic.name)}${clinic.contact?.website ? ' \u00b7 ' + escapeHtml(clinic.contact.website) : ''}<br>${L.footer}</div>
</body></html>`;
}

export async function renderComplianceReportPdf({ clinic, report, lang }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(buildComplianceReportHtml({ clinic, report, lang: lang || 'en' }), { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true });
  } finally {
    await page.close();
  }
}

export async function closePdfBrowser() {
  if (cachedBrowser) { await cachedBrowser.close(); cachedBrowser = null; }
}
