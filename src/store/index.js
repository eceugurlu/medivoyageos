// Unified conversation/lead store.
//
// • DATABASE_URL set  → Postgres (leads, conversations, messages persisted;
//                        idempotency + lead scoring + handover state).
// • DATABASE_URL blank → in-memory fallback (history only, resets on restart),
//                        so you can still test the WhatsApp/AI round-trip locally
//                        without standing up a database.
//
// Both expose the SAME two calls used by the webhook: loadContext + saveExchange.

import { dbEnabled } from '../db/pool.js';
import * as db from './repository.js';
import { getHistory, appendTurn } from './conversations.js';

export { dbEnabled };

export async function loadContext(phone, { name, wamid } = {}) {
  if (dbEnabled) return db.loadContext(phone, { name, wamid });
  // In-memory: no real dedup or lead rows, just prior turns for context.
  return { duplicate: false, history: getHistory(phone), ctx: {} };
}

export async function saveExchange(phone, { userText, inboundWamid, reply, meta, ctx } = {}) {
  if (dbEnabled) {
    return db.saveExchange(phone, { userText, inboundWamid, reply, meta, ctx });
  }
  appendTurn(phone, 'user', userText);
  appendTurn(phone, 'assistant', reply);
}

export async function getLead(leadId) {
  if (dbEnabled) return db.getLead(leadId);
  return null; // in-memory mode has no lead rows
}

export async function setCrmLeadId(leadId, crmId) {
  if (dbEnabled) return db.setCrmLeadId(leadId, crmId);
}

export async function saveInboundMessage(ctx, payload) {
  if (dbEnabled) return db.saveInboundMessage(ctx, payload);
  // in-memory takeover isn't tracked; nothing to do
}
