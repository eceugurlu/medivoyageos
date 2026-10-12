// İyzico Checkout Form — the second deposit-link provider alongside Stripe.
// Auth scheme, endpoints and field names verified against İyzico's current
// official docs (docs.iyzico.com: authentication/hmacsha256-auth,
// payment-methods/checkoutform/cf-implementation/{cf-initialize,cf-retrieve})
// as of this writing — this is NOT guessed from general payment-API
// conventions, since a wrong signature scheme here would just fail silently
// on the auth check.
import crypto from 'node:crypto';
import { config } from '../config.js';

export const iyzicoEnabled = Boolean(config.iyzico.apiKey && config.iyzico.secretKey);

// IYZWSv2 signature: HMACSHA256(randomKey + uriPath + requestBodyString, secretKey)
// as a HEX digest, then base64("apiKey:<key>&randomKey:<rk>&signature:<hex>").
// uriPath is the path only (no host/query); requestBodyString must be the
// exact same JSON string sent as the request body, since it's part of the
// signed payload.
function authHeaders(uriPath, bodyString) {
  const randomKey = `${Date.now()}${crypto.randomInt(100000000, 999999999)}`;
  const payload = bodyString ? randomKey + uriPath + bodyString : randomKey + uriPath;
  const signature = crypto.createHmac('sha256', config.iyzico.secretKey).update(payload).digest('hex');
  const authString = `apiKey:${config.iyzico.apiKey}&randomKey:${randomKey}&signature:${signature}`;
  const base64Auth = Buffer.from(authString, 'utf8').toString('base64');
  return { Authorization: `IYZWSv2 ${base64Auth}`, 'x-iyzi-rnd': randomKey };
}

// Same reasoning as whatsapp.js's HTTP_TIMEOUT_MS (shared 30s Vercel function
// budget for every route) — a hung İyzico call needs to throw on its own
// rather than rely on the platform's blunt kill.
const HTTP_TIMEOUT_MS = 15_000;

async function iyzicoRequest(uriPath, body) {
  const bodyString = JSON.stringify(body);
  const res = await fetch(`${config.iyzico.baseUrl}${uriPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(uriPath, bodyString) },
    body: bodyString,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'failure') {
    console.error('[iyzico] request failed', res.status, JSON.stringify(data));
    throw new Error(data?.errorMessage || `İyzico request failed: ${res.status}`);
  }
  return data;
}

/**
 * Create a hosted Checkout Form page for a single amount. Unlike Stripe,
 * İyzico's API mandates buyer/address/identity fields that a lead-stage
 * patient hasn't given us yet (no billing address, no ID number collected
 * over WhatsApp) — those are filled with clearly-marked placeholders below;
 * real KYC still happens at the clinic, not through this field. Dry-run (no
 * İyzico keys): returns a fake token so the create → persist → send pipeline
 * is fully exercisable without a real İyzico account, same convention as stripe.js.
 */
export async function createCheckoutForm({
  paymentId, amount, currency, description, buyerName, buyerPhone, buyerCountry, language, callbackUrl,
}) {
  if (!iyzicoEnabled) {
    const fakeToken = `dryrun_${crypto.randomBytes(8).toString('hex')}`;
    console.log(`[iyzico:dry-run] would create a ${amount} ${currency} checkout form (${description}) for payment ${paymentId}`);
    return { token: fakeToken, url: null, dryRun: true };
  }

  const price = String(amount);
  const [firstName, ...rest] = (buyerName || 'Patient Patient').trim().split(/\s+/);
  const lastName = rest.join(' ') || 'Patient';
  // A generic, honest placeholder — the real address is collected at
  // check-in, not at deposit-link stage. Non-empty string is all the API
  // itself requires.
  const addressPlaceholder = 'Collected at clinic check-in';

  const body = {
    locale: language === 'tr' ? 'tr' : 'en',
    conversationId: paymentId, // our own payment row id — echoed back by CF-Retrieve, is how the callback maps back to it
    price,
    paidPrice: price,
    currency,
    basketId: paymentId,
    paymentGroup: 'PRODUCT',
    callbackUrl,
    buyer: {
      id: paymentId,
      name: firstName,
      surname: lastName,
      // Foreign-cardholder placeholder: this field expects a Turkish TC
      // kimlik no; "11111111111" is the standard stand-in used across
      // Turkish payment gateways for non-Turkish cardholders. Needs a real
      // sandbox test to confirm İyzico's own validation accepts it as-is.
      identityNumber: '11111111111',
      email: 'patient@medivoyage-demo.invalid', // RFC 2606 reserved TLD — passes format checks, not a real deliverable address
      gsmNumber: buyerPhone ? `+${String(buyerPhone).replace(/\D/g, '')}` : '+900000000000',
      registrationAddress: addressPlaceholder,
      city: 'Istanbul',
      country: buyerCountry || 'Turkey',
      ip: '85.34.78.112', // placeholder — this call runs coordinator-side in the panel, not from the patient's own browser
    },
    shippingAddress: { address: addressPlaceholder, contactName: buyerName || 'Patient', city: 'Istanbul', country: buyerCountry || 'Turkey' },
    billingAddress: { address: addressPlaceholder, contactName: buyerName || 'Patient', city: 'Istanbul', country: buyerCountry || 'Turkey' },
    basketItems: [{ id: paymentId, price, name: description, category1: 'Medical Deposit', itemType: 'VIRTUAL' }],
  };

  const data = await iyzicoRequest('/payment/iyzipos/checkoutform/initialize/auth/ecom', body);
  return { token: data.token, url: data.paymentPageUrl, dryRun: false };
}

/**
 * Server-to-server confirmation call — the ONLY trustworthy source for
 * "was this actually paid". İyzico's callbackUrl is a plain, unsigned POST
 * from the patient's own browser carrying just a token; it proves nothing by
 * itself; retrieving the result with our own secret key does.
 */
export async function retrieveCheckoutForm(token) {
  if (!iyzicoEnabled) return { paid: false, conversationId: null, raw: null, dryRun: true };
  const data = await iyzicoRequest('/payment/iyzipos/checkoutform/auth/ecom/detail', {
    locale: 'en',
    token,
  });
  return { paid: data.paymentStatus === 'SUCCESS', conversationId: data.conversationId, raw: data };
}
