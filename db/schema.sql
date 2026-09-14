-- ─────────────────────────────────────────────────────────────────────────
-- MediVoyage OS — Adım 4: PostgreSQL kalıcı katman şeması
--
-- Çalıştırmak için:
--   psql "$DATABASE_URL" -f db/schema.sql
--
-- Bu MVP tek klinik varsayımıyla çalışır (spec'teki `clinics` tablosu
-- hazır — çoklu klinik desteği ileride sadece webhook.js'te
-- phone_number_id → clinic_id eşlemesiyle açılır, şema zaten hazır).
-- ─────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() için

-- ── clinics ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  whatsapp_phone_id  TEXT UNIQUE,        -- Meta phone_number_id — hangi mesaj hangi kliniğe ait, bununla çözülür
  profile            JSONB,              -- düzenlenebilir klinik bilgi tabanı (AI Prompt Studio)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── leads ───────────────────────────────────────────────────────────────
-- Bir hasta = bir lead. Telefon numarası + klinik ile tekilleştirilir.
CREATE TABLE IF NOT EXISTS leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  phone               TEXT NOT NULL,             -- WhatsApp 'from' — E.164, '+' olmadan
  name                TEXT,
  country             TEXT,
  language            TEXT,                      -- concierge'in tespit ettiği son dil (ISO kodu)
  treatment_interest  TEXT,
  budget_hint         TEXT,
  readiness           TEXT CHECK (readiness IN ('researching', 'considering', 'ready_to_book')),
  score               INTEGER CHECK (score BETWEEN 0 AND 100),
  status              TEXT NOT NULL DEFAULT 'new', -- new | hot | handed_over | booked | lost
  source              TEXT DEFAULT 'whatsapp',     -- whatsapp | widget | instagram ...
  coordinator_id      UUID,                        -- assigned language coordinator
  consent             BOOLEAN NOT NULL DEFAULT false, -- data-processing consent
  crm_lead_id         TEXT,                        -- Zoho Lead record id (once synced)
  medical_note        TEXT,                        -- brief clinical note from the AI (e.g. complication)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, phone)
);

-- ── conversations ───────────────────────────────────────────────────────
-- Şimdilik lead başına tek açık konuşma (WhatsApp thread'i doğası gereği tekil).
CREATE TABLE IF NOT EXISTS conversations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id        UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel        TEXT NOT NULL DEFAULT 'whatsapp',
  status         TEXT NOT NULL DEFAULT 'ai_handling', -- ai_handling | needs_human | human_handling | closed
  handover_reason TEXT,
  urgent         BOOLEAN NOT NULL DEFAULT false,   -- urgent medical escalation
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id)
);

-- ── messages ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content           TEXT NOT NULL,
  whatsapp_message_id TEXT,             -- Meta'nın mesaj id'si — dedup/idempotency için
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_clinic_phone ON leads(clinic_id, phone);

-- ── campaigns (ad spend, for CAC/ROAS analytics) ───────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID REFERENCES clinics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  channel     TEXT,
  spend       NUMERIC(12,2) NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── coordinators (sales consultants) + language routing ────────────────
CREATE TABLE IF NOT EXISTS coordinators (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID REFERENCES clinics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  languages   TEXT[] NOT NULL DEFAULT '{}',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── branches (physical sites under a clinic — Öncelik 4) ───────────────
-- Klinik = tenant / WhatsApp hattı. Şube = o kliniğin fiziksel lokasyonu.
CREATE TABLE IF NOT EXISTS branches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT,
  city        TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_one_default
  ON branches (clinic_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_branches_clinic ON branches (clinic_id);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE coordinators
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leads_branch ON leads (branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coordinators_branch ON coordinators (branch_id) WHERE branch_id IS NOT NULL;

-- Webhook retry'larında aynı Meta mesajını iki kere işlememek için (idempotency).
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wamid ON messages(whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

-- ── demo/default clinic (MVP tek klinik) ───────────────────────────────
INSERT INTO clinics (name, whatsapp_phone_id)
SELECT 'Este Future Clinic', NULL
WHERE NOT EXISTS (SELECT 1 FROM clinics);

-- ── operations: devices, appointments, post-op tasks, logistics ────────
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT, active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS post_op_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS logistics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
  flight_no TEXT, arrival_at TIMESTAMPTZ,
  transfer_status TEXT NOT NULL DEFAULT 'pending',
  hotel_status TEXT NOT NULL DEFAULT 'pending',
  appointment_status TEXT NOT NULL DEFAULT 'pending',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
