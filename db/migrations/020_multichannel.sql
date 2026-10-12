-- Instagram DM + Facebook Messenger, sharing the same leads/conversations/
-- messages pipeline WhatsApp already uses. Those two platforms never expose
-- a phone number — a lead is identified by a Page/Instagram-scoped ID
-- (PSID/IGSID) instead, so `phone` has to become optional, and a new
-- (clinic, source, external_id) identity is added alongside the existing
-- (clinic, phone) one WhatsApp/widget leads use. Purely additive: existing
-- WhatsApp rows are untouched, external_id stays NULL for them.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/020_multichannel.sql

ALTER TABLE leads ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_channel_external
  ON leads (clinic_id, source, external_id) WHERE external_id IS NOT NULL;
