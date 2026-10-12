-- Doctor Portal: a doctor signs in with their own token, reviews the photos
-- of leads assigned to them, and leaves a suitability approval + note —
-- separate from the AI's own clinical_note (that's the AI's read; this is
-- the qualified doctor's actual sign-off).
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/017_doctors.sql

CREATE TABLE IF NOT EXISTS doctors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text,
  specialty   text,
  api_token   text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doctors_clinic ON doctors (clinic_id);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS doctor_id uuid REFERENCES doctors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS doctor_review_status text CHECK (doctor_review_status IN ('pending','approved','needs_info')),
  ADD COLUMN IF NOT EXISTS doctor_note text,
  ADD COLUMN IF NOT EXISTS doctor_reviewed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_leads_doctor ON leads (doctor_id) WHERE doctor_id IS NOT NULL;
