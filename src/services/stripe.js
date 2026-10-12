// One-click international deposit/payment links. Uses Stripe's plain REST
// API via fetch (no SDK) — same convention as whatsapp.js/metaMessaging.js/
// zoho.js/fx.js in this codebase — so there's no extra dependency to bundle
// for a Vercel serverless function.
import crypto from 'node:crypto';
import { config } from '../config.js';

export const stripeEnabled = Boolean(config.stripe.secretKey);

// Stripe's mapped locales are a fixed list (not full BCP-47) — 'auto' lets
// Stripe's own Checkout page pick from the browser, which is a safe default
// for any language we don't have an exact mapping for.
const STRIPE_LOCALE_BY_LANG = {
  en: 'en', tr: 'tr', de: 'de', ar: 'ar', ru: 'ru', fr: 'fr',
};
export function stripeLocaleFor(language) {
  return STRIPE_LOCALE_BY_LANG[language] || 'auto';
}

// Stripe's API takes application/x-www-form-urlencoded with bracket-notation
// keys for nested objects/arrays (e.g. line_items[0][price_data][currency]),
// not JSON. This walks a plain JS object/array and builds that shape.
function flattenToForm(value, prefix, params) {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenToForm(v, `${prefix}[${i}]`, params));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      flattenToForm(v, prefix ? `${prefix}[${k}]` : k, params);
    }
  } else {
    params.append(prefix, String(value));
  }
}
function toFormBody(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) flattenToForm(v, k, params);
  return params;
}

// Same reasoning as whatsapp.js's HTTP_TIMEOUT_MS (shared 30s Vercel function
// budget for every route) — a hung Stripe call needs to throw on its own
// rather than rely on the platform's blunt kill.
const HTTP_TIMEOUT_MS = 15_000;

async function stripeRequest(path, body) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.stripe.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: toFormBody(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[stripe] request failed', res.status, JSON.stringify(data));
    throw new Error(data?.error?.message || `Stripe request failed: ${res.status}`);
  }
  return data;
}

/**
 * Create a one-time hosted Checkout page for a single amount, in the
 * patient's own currency. clientReferenceId carries our own payment row id
 * so the webhook can mark the right row paid without a second lookup table.
 * Dry-run (no STRIPE_SECRET_KEY): returns a fake session so the rest of the
 * create → persist → send pipeline is fully exercisable without a real
 * Stripe account, matching how WhatsApp/Meta/Zoho behave in this codebase.
 */
export async function createCheckoutSession({
  amount, currency, description, clientReferenceId, language, successUrl, cancelUrl,
}) {
  if (!stripeEnabled) {
    const fakeId = `dryrun_${crypto.randomBytes(8).toString('hex')}`;
    console.log(`[stripe:dry-run] would create a ${amount} ${currency} checkout session (${description}) for payment ${clientReferenceId}`);
    return { id: fakeId, url: null, dryRun: true };
  }

  const session = await stripeRequest('checkout/sessions', {
    mode: 'payment',
    client_reference_id: clientReferenceId,
    locale: stripeLocaleFor(language),
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: Math.round(Number(amount) * 100), // Stripe wants the smallest currency unit
        product_data: { name: description },
      },
    }],
  });
  return { id: session.id, url: session.url, dryRun: false };
}

// Stripe signs each webhook POST as `t=<unix ts>,v1=<hex hmac>` in the
// Stripe-Signature header, over `${timestamp}.${rawBody}` — same shape as
// Meta's x-hub-signature-256 check in verifySignature.js, just Stripe's own
// scheme. Enforced ONLY when STRIPE_WEBHOOK_SECRET is set, same "test first,
// lock down before going live" convention as WHATSAPP_APP_SECRET.
export function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!secret) return true; // verification disabled — dev/dry-run mode
  if (!sigHeader || !rawBody) return false;

  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Reject anything older than 5 minutes — Stripe's own recommended replay guard.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
