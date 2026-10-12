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

export async function loadContext({ phone, externalId, source, name, wamid, userText, image } = {}) {
  if (dbEnabled) return db.loadContext({ phone, externalId, source, name, wamid, userText, image });
  // In-memory: no real dedup or lead rows, just prior turns for context.
  // Keyed by phone when present (WhatsApp/widget), else the platform id
  // (Instagram/Messenger) — either way, one string identifies the thread.
  return { duplicate: false, history: getHistory(phone || externalId), ctx: {} };
}

export async function saveExchange(identity, { userText, reply, meta, ctx } = {}) {
  if (dbEnabled) {
    // The DB path's inbound-message insert already happened inside
    // loadContext() (see its docstring) — db.saveExchange only needs
    // reply/meta/ctx now; userText is simply ignored if passed.
    return db.saveExchange(identity, { reply, meta, ctx });
  }
  // In-memory fallback has no such claim mechanism (single-process, dev/test
  // only) — both turns are appended here, same as before.
  appendTurn(identity, 'user', userText);
  appendTurn(identity, 'assistant', reply);
}

export async function getLead(leadId) {
  if (dbEnabled) return db.getLead(leadId);
  return null; // in-memory mode has no lead rows
}

export async function setCrmLeadId(leadId, crmId) {
  if (dbEnabled) return db.setCrmLeadId(leadId, crmId);
}
