-- Hot-lead follow-up: a lead marked 'hot' that's gone silent for 48h gets an
-- automatic WhatsApp re-engagement template. hot_followup_sent_at tracks the
-- last send so the daily cron doesn't re-fire every day on the same silence —
-- same "notify once per crossing" discipline as leads.risk_notified_at.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/016_hot_lead_followup.sql

ALTER TABLE leads ADD COLUMN IF NOT EXISTS hot_followup_sent_at timestamptz;
