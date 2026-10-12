import crypto from 'crypto';
import { config, isProduction } from '../config.js';

// Meta signs every webhook POST with HMAC-SHA256 using your App Secret, in the
// `x-hub-signature-256` header. Skipping that check is a local-dev
// convenience only: this endpoint's body is fully attacker-controlled, and
// everything downstream treats it as a real patient message — it creates
// leads, spends Anthropic credit, pings staff, and (the serious one) sends an
// outbound reply to the `from` number carried IN that same body. Unsigned,
// that makes the clinic's own verified WhatsApp number a spam relay pointed at
// any number an attacker likes, which is how a business number gets banned by
// Meta. So on a production deployment a missing secret rejects instead of
// waving the request through.
export function verifySignature(req, res, next) {
  if (!config.whatsapp.appSecret) {
    if (isProduction) {
      console.error(
        '[webhook] REJECTED: WHATSAPP_APP_SECRET is not set on this production deployment, ' +
          'so incoming webhooks cannot be verified as genuinely from Meta. ' +
          'Copy the App Secret from Meta App Dashboard → Settings → Basic and set it as the ' +
          'WHATSAPP_APP_SECRET environment variable. Until then all webhook deliveries are refused.',
      );
      return res.status(401).send('Webhook signature verification is not configured');
    }
    return next(); // local dev only
  }

  const signature = req.get('x-hub-signature-256');
  if (!signature || !req.rawBody) {
    return res.status(401).send('Missing signature');
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.rawBody).digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).send('Invalid signature');
  }
  next();
}