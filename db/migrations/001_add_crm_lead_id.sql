-- Adım 5 (Zoho) — mevcut veritabanına crm_lead_id kolonunu ekler.
-- schema.sql'i zaten çalıştırdıysan bunu bir kez çalıştır:
--   psql "$DATABASE_URL" -f db/migrations/001_add_crm_lead_id.sql
-- (Yeni/temiz kurulumda gerekmez — schema.sql zaten içeriyor.)

ALTER TABLE leads ADD COLUMN IF NOT EXISTS crm_lead_id TEXT;
