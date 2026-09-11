import crypto from 'crypto';
import { config } from '../config.js';

// Meta signs every webhook POST with HMAC-SHA256 using your App Secret,
// in the `x-hub-signature-256` header. We enforce this ONLY when
// WHATSAPP_APP_SECRET is set — so you can test quickly first, then lock it down.
export function verifySignature(req, res, next) {
  if (!config.whatsapp.appSecret) return next(); // verification disabled

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