-- Klinik güvenlik: acil tıbbi yükseltme bayrağı + klinik not.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/006_clinical.sql

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS medical_note TEXT;
