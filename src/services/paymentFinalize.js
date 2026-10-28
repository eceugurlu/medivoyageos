// The one place a payment actually gets marked paid from a gateway
// confirmation and the team notified — shared by routes/stripeWebhook.js and
// routes/iyzicoWebhook.js so the two gateways can't drift into notifying
// differently or one of them missing a fix the other already has.
import { markPaymentPaidByWebhook, getLeadChannel, enqueueConversionEvent } from '../store/repository.js';
import { notifyPaymentReceived } from './notify.js';

export async function finalizePaidPayment(paymentId, providerSessionId, logPrefix) {
  const payment = await markPaymentPaidByWebhook(paymentId, providerSessionId);
  if (!payment) {
    console.log(`[${logPrefix}] payment ${paymentId} already paid (or unknown) — skipping`);
    return null;
  }
  console.log(`[${logPrefix}] payment ${paymentId} marked paid — ${payment.currency} ${payment.amount}`);

  // Meta'ya dönüşüm bildirimi. Kuyruğa yazılır, BURADA gönderilmez: bir
  // ödeme onayı Meta yavaşladı diye zaman aşımına uğrayamaz. dedup_key
  // ödemenin kendi kimliği olduğu için webhook iki kez gelse de Purchase
  // bir kez gider.
  await enqueueConversionEvent({
    leadId: payment.lead_id,
    eventName: 'Purchase',
    dedupKey: `purchase:${payment.id}`,
    value: payment.amount,
    currency: payment.currency,
  }).catch((e) => console.error(`[${logPrefix}] capi kuyruğa yazılamadı:`, e.message));

  const lead = await getLeadChannel(payment.lead_id).catch(() => null);
  await notifyPaymentReceived({
    name: lead?.name,
    phone: lead?.phone,
    amount: payment.amount,
    currency: payment.currency,
    type: payment.type,
  });
  return payment;
}
