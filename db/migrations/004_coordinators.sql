-- Modül 4+5: Satış koordinatörleri + dile göre otomatik yönlendirme.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/004_coordinators.sql

CREATE TABLE IF NOT EXISTS coordinators (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID REFERENCES clinics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  languages   TEXT[] NOT NULL DEFAULT '{}',   -- ISO kodları: de, en, ar, ru, fr, tr ...
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS coordinator_id UUID REFERENCES coordinators(id);
