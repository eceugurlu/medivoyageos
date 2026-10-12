import { Router } from 'express';
import { waitUntil } from '@vercel/functions';
import { retrieveCheckoutForm } from '../services/iyzico.js';
import { finalizePaidPayment } from '../services/paymentFinalize.js';

export const iyzicoWebhookRouter = Router();

// İyzico's Checkout Form redirects the PATIENT'S OWN BROWSER here via a plain
// POST carrying just a `token` — unlike Stripe's signed server-to-server
// webhook, that POST proves nothing by itself (a browser redirect can be
// replayed or forged). It's made trustworthy by never believing the POST
// body: we always call İyzico's own Retrieve endpoint — authenticated with
// our secret key — for the true payment status before marking anything paid.
// The browser needs an answer to redirect to, so (unlike the fire-and-forget
// Stripe/Meta webhooks) this one call is awaited before responding; the DB
// write + notify after that don't affect what the patient sees, so those run
// in the background via waitUntil(), same as the other webhooks.
iyzicoWebhookRouter.post('/callback', async (req, res) => {
  const token = req.body?.token;
  const lang = encodeURIComponent(req.query.lang || 'en');
  if (!token) return res.redirect(`/panel/payment-result.html?status=cancel&lang=${lang}`);

  let result;
  try {
    result = await retrieveCheckoutForm(token);
  } catch (err) {
    console.error('[iyzico-webhook] retrieve failed', err.message);
    return res.redirect(`/panel/payment-result.html?status=cancel&lang=${lang}`);
  }

  if (!result.paid || !result.conversationId) {
    return res.redirect(`/panel/payment-result.html?status=cancel&lang=${lang}`);
  }

  res.redirect(`/panel/payment-result.html?status=success&lang=${lang}`);
  // conversationId is OUR payment row id — set as such at createCheckoutForm() time.
  waitUntil(
    finalizePaidPayment(result.conversationId, result.raw?.token, 'iyzico-webhook')
      .catch((err) => console.error('[iyzico-webhook] finalize error', err)),
  );
});
