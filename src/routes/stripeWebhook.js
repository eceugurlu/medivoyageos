import { Router } from 'express';
import { waitUntil } from '@vercel/functions';
import { config, isProduction } from '../config.js';
import { verifyStripeSignature } from '../services/stripe.js';
import { finalizePaidPayment } from '../services/paymentFinalize.js';
import { notifySystemAlert } from '../services/notify.js';

export const stripeWebhookRouter = Router();

// Same fast-ack-then-process shape as routes/webhook.js's Meta handler, and
// for the same reason: a Vercel function can freeze the instant its response
// is sent, so the DB write + notify below need waitUntil() to be guaranteed
// to finish rather than an ordinary await before responding (which would
// also risk a slow-response-triggered Stripe retry, piling up duplicate
// events for the same session).
stripeWebhookRouter.post('/', (req, res) => {
  // verifyStripeSignature() treats a missing secret as "checks disabled" for
  // local dry-runs. On a production deployment that would mean any anonymous
  // POST could mark a deposit as paid, so the missing secret is itself the
  // rejection here rather than a reason to skip the check.
  if (isProduction && !config.stripe.webhookSecret) {
    console.error(
      '[stripe-webhook] REJECTED: STRIPE_WEBHOOK_SECRET is not set on this production deployment. ' +
        'Without it a forged POST would mark a deposit paid that was never received. ' +
        'Get the signing secret from Stripe Dashboard → Developers → Webhooks and set STRIPE_WEBHOOK_SECRET.',
    );
    return res.sendStatus(401);
  }
  const sig = req.get('stripe-signature');
  if (!verifyStripeSignature(req.rawBody, sig, config.stripe.webhookSecret)) {
    console.warn('[stripe-webhook] signature check failed — rejecting');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  waitUntil(
    handleEvent(req.body).catch((err) => {
      console.error('[stripe-webhook] handler error', err);
      // Each failure here is its own patient's payment confirmation that did
      // NOT get recorded — alerted directly and unconditionally, not via the
      // threshold/cooldown logic in healthMonitor.js, because a cooldown
      // would wrongly suppress a second, unrelated failure landing soon
      // after the first (both still matter independently).
      notifySystemAlert({
        severity: 'critical',
        title: 'Stripe webhook failed to process a payment event',
        detail: err.message,
      }).catch(() => {});
    }),
  );
});

async function handleEvent(event) {
  // checkout.session.completed fires once the patient finishes the Checkout
  // flow — but for delayed-settlement methods (some bank debits) that can
  // happen before the money has actually cleared, with payment_status still
  // 'unpaid'/'processing'; async_payment_succeeded is Stripe's follow-up event
  // once those actually settle. Both carry the same Checkout Session shape.
  // Only payment_status 'paid' is the trustworthy "it's paid" signal (never
  // the patient's browser landing on success_url, which proves nothing).
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event?.type)) return;

  const session = event.data?.object;
  if (session?.payment_status !== 'paid') {
    console.log(`[stripe-webhook] session ${session?.id} completed but payment_status=${session?.payment_status} — not marking paid yet`);
    return;
  }
  const paymentId = session?.client_reference_id;
  if (!paymentId) {
    console.warn('[stripe-webhook] checkout.session.completed with no client_reference_id — ignoring');
    return;
  }

  await finalizePaidPayment(paymentId, session.id, 'stripe-webhook');
}
