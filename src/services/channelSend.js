// Sends a plain-text message to a lead on whichever channel it actually
// reached the clinic through — the same three-way dispatch webhook.js uses
// to reply to an inbound message, pulled out here so panel-triggered sends
// (a payment link, in the first case) can reuse it too.
import { sendText } from './whatsapp.js';
import { sendInstagramText, sendMessengerText } from './metaMessaging.js';

export async function sendToLead(lead, text) {
  if (lead.source === 'instagram') return sendInstagramText(lead.external_id, text);
  if (lead.source === 'messenger') return sendMessengerText(lead.external_id, text);
  if (!lead.phone) throw new Error('lead has no reachable channel (no phone, no external_id)');
  return sendText(lead.phone, text);
}
