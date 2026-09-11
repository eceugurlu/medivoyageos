-- Hasta veri işleme onayı (KVKK/GDPR) — web widget'ından gelen lead'ler için.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/007_consent.sql

ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent BOOLEAN NOT NULL DEFAULT false;
