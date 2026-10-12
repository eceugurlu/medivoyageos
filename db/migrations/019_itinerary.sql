-- Patient-facing live itinerary link — "you'll be picked up from the lobby
-- at 10:00, your consultation with Dr. X is at 11:00" as an actual page the
-- patient can open, not just an internal status board. No PNR auto-lookup
-- (would need a flight-data API/credentials this clinic doesn't have) — the
-- coordinator sets pickup/appointment times manually in the Logistics panel;
-- this just gives the patient their own honest, always-current view of them.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/019_itinerary.sql

ALTER TABLE logistics
  ADD COLUMN IF NOT EXISTS pickup_at timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_location text,
  ADD COLUMN IF NOT EXISTS next_appointment_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_appointment_note text,
  ADD COLUMN IF NOT EXISTS view_token text UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex');
