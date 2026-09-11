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

async function getBrowser() {
  if (cachedBrowser && cachedBrowser.connected) return cachedBrowser;
  cachedBrowser = await puppeteer.launch({
    executablePath: findChromePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  return cachedBrowser;
}

// Labels used inside the PDF itself, in every language the clinic serves.
// Falls back to English for anything not listed.
const RTL_LANGS = new Set(['ar', 'fa', 'he', 'ur']);
const LABELS = {
  en: { quote: 'Treatment Quote', item: 'Item', qty: 'Qty', unitPrice: 'Unit price', total: 'Total', validUntil: 'Valid until', preparedFor: 'Prepared for', contactUs: 'Questions? Just reply on WhatsApp.' },
  tr: { quote: 'Tedavi Teklifi', item: 'Kalem', qty: 'Adet', unitPrice: 'Birim fiyat', total: 'Toplam', validUntil: 'Geçerlilik tarihi', preparedFor: 'Hazırlanan hasta', contactUs: 'Sorularınız için WhatsApp\'tan yazmanız yeterli.' },
  de: { quote: 'Behandlungsangebot', item: 'Position', qty: 'Menge', unitPrice: 'Einzelpreis', total: 'Gesamt', validUntil: 'Gültig bis', preparedFor: 'Erstellt für', contactUs: 'Fragen? Schreiben Sie uns einfach auf WhatsApp.' },
  ar: { quote: 'عرض سعر العلاج', item: 'البند', qty: 'الكمية', unitPrice: 'سعر الوحدة', total: 'الإجمالي', validUntil: 'صالح حتى', preparedFor: 'أُعِدّ من أجل', contactUs: 'لديك أسئلة؟ راسلنا على واتساب.' },
  ru: { quote: 'Смета лечения', item: 'Позиция', qty: 'Кол-во', unitPrice: 'Цена за ед.', total: 'Итого', validUntil: 'Действительно до', preparedFor: 'Подготовлено для', contactUs: 'Есть вопросы? Напишите нам в WhatsApp.' },
  fr: { quote: 'Devis de traitement', item: 'Article', qty: 'Qté', unitPrice: 'Prix unitaire', total: 'Total', validUntil: 'Valable jusqu\'au', preparedFor: 'Préparé pour', contactUs: 'Des questions ? Écrivez-nous sur WhatsApp.' },
};
function labelsFor(lang) { return LABELS[lang] || LABELS.en; }

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtMoney(amount, currency) {
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount); }
  catch { return `${currency} ${Number(amount).toFixed(2)}`; }
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
  <div class="meta">${L.preparedFor}: <b>${escapeHtml(lead.name || lead.phone)}</b></div>
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

export async function closePdfBrowser() {
  if (cachedBrowser) { await cachedBrowser.close(); cachedBrowser = null; }
}
