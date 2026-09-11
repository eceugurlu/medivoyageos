-- Adım 6+ modülleri: lead kaynağı + reklam kampanyaları (CAC/ROAS analitiği için).
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/002_widget_and_campaigns.sql

ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'whatsapp';

CREATE TABLE IF NOT EXISTS campaigns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID REFERENCES clinics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  channel     TEXT,                          -- 'meta_ads' | 'google' | 'instagram' ...
  spend       NUMERIC(12,2) NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
