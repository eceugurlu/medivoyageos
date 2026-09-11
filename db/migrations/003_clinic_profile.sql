-- AI Prompt Studio (Modül 11): klinik profilini panelden düzenlenebilir kılar.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/003_clinic_profile.sql

ALTER TABLE clinics ADD COLUMN IF NOT EXISTS profile JSONB;
