-- Koordinatörlerin bir hasta hakkında birbirlerine bıraktığı iç notlar.
-- (leads.medical_note AI'ın yazdığı klinik nottur; bu ondan ayrıdır ve
--  hastaya asla gösterilmez.)
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/008_lead_notes.sql

CREATE TABLE IF NOT EXISTS lead_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  uuid REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author     text,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes (lead_id, created_at DESC);
