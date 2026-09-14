-- Öncelik 4: Çoklu şube. Klinik (tenant) altında fiziksel lokasyonlar.
-- leads/coordinators.branch_id NULL = atanmamış; filtre yoksa mevcut global
-- davranış korunur (geriye dönük kırılmaz).
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/012_branches.sql

CREATE TABLE IF NOT EXISTS branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text,
  city        text,
  active      boolean NOT NULL DEFAULT true,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- En fazla bir varsayılan şube per klinik.
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_one_default
  ON branches (clinic_id) WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_branches_clinic ON branches (clinic_id);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE coordinators
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_branch ON leads (branch_id)
  WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coordinators_branch ON coordinators (branch_id)
  WHERE branch_id IS NOT NULL;
