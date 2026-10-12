// Shared structured-output schema fragments for "what the AI concluded about
// this turn" — lead-scoring + handover flags. Used by concierge.js's
// `send_reply` tool (text channel, bundled together with the reply text) AND
// by src/voice/brain.js's turn-signal extractor (voice channel, a SEPARATE
// call from the spoken reply — see docs/VOICE.md for why). Pulled out once so
// the two can never drift apart; this file has no behavior of its own.

export const DETECTED_LANGUAGE_SCHEMA = {
  type: 'string',
  description: 'ISO code, e.g. de, en, ar, ru, fr, it, tr',
};

export const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: ['string', 'null'] },
    country: { type: ['string', 'null'] },
    treatment_interest: { type: ['string', 'null'] },
    budget_hint: { type: ['string', 'null'] },
    readiness: { type: 'string', enum: ['researching', 'considering', 'ready_to_book'] },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    medical_note: { type: ['string', 'null'], description: 'Brief clinical/crisis summary when handover fires for a medical or crisis reason, else null.' },
  },
  required: ['readiness', 'score'],
};

export const HANDOVER_SCHEMA = {
  type: 'object',
  properties: {
    needed: { type: 'boolean' },
    urgent: { type: 'boolean' },
    reason: { type: ['string', 'null'] },
  },
  required: ['needed', 'urgent'],
};
