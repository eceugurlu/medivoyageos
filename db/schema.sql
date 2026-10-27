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
  phone               TEXT,                      -- WhatsApp 'from' — E.164, '+' olmadan. NULL for Instagram/Messenger (see external_id below)
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
  external_id         TEXT,                        -- Instagram/Messenger PSID or IGSID (no phone number on those platforms)
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

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_data      BYTEA,
  ADD COLUMN IF NOT EXISTS media_mime_type TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_clinic_phone ON leads(clinic_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_channel_external
  ON leads (clinic_id, source, external_id) WHERE external_id IS NOT NULL;

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

-- ── lead notes (internal, coordinator-to-coordinator) ───────────────────
CREATE TABLE IF NOT EXISTS lead_notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  UUID REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id    UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author     TEXT,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes (lead_id, created_at DESC);

-- ── payments (deposit/balance tracking) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         UUID REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  amount            NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  currency          TEXT NOT NULL DEFAULT 'EUR',
  type              TEXT NOT NULL DEFAULT 'deposit' CHECK (type IN ('deposit','balance','full')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','refunded')),
  due_date          DATE,
  paid_at           TIMESTAMPTZ,
  reminder_sent_at  TIMESTAMPTZ,
  note              TEXT,
  provider            TEXT,        -- 'stripe' once a checkout link has been created for this row
  checkout_url        TEXT,        -- the hosted Stripe Checkout URL sent to the patient
  provider_session_id TEXT,        -- Stripe Checkout Session id — how the webhook finds this row back
  link_sent_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_lead   ON payments (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_session
  ON payments (provider_session_id) WHERE provider_session_id IS NOT NULL;

-- ── quotes (Treatment Plan Builder) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  items         JSONB NOT NULL DEFAULT '[]',
  total_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'EUR',
  language      TEXT NOT NULL DEFAULT 'en',
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','viewed','accepted')),
  valid_until   DATE,
  view_token    TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  viewed_at     TIMESTAMPTZ,
  accepted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_quotes_lead  ON quotes (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_token ON quotes (view_token);

-- No-show/cancellation risk notification state (see repository.js getNoShowRisks).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS risk_notified_at TIMESTAMPTZ;

-- ── partners (referral agents — Partner Portalı) ────────────────────────
CREATE TABLE IF NOT EXISTS partners (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  email            TEXT,
  api_token        TEXT NOT NULL UNIQUE,          -- private: logs into this partner's own dashboard, never published
  referral_code    TEXT NOT NULL UNIQUE,           -- public: safe to share, only attributes a lead — see migration 022
  commission_rate  NUMERIC(5,2) NOT NULL DEFAULT 10.00 CHECK (commission_rate >= 0 AND commission_rate <= 100),
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partners_clinic ON partners (clinic_id);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leads_partner ON leads (partner_id) WHERE partner_id IS NOT NULL;

-- ROI Widget: AI-authored vs. human-agent replies (see 015_roi.sql).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_ai BOOLEAN;

-- Hot-lead follow-up cron (see 016_hot_lead_followup.sql).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS hot_followup_sent_at TIMESTAMPTZ;

-- ── doctors (Doctor Portal — suitability review) ─────────────────────────
CREATE TABLE IF NOT EXISTS doctors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  specialty   TEXT,
  api_token   TEXT NOT NULL UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doctors_clinic ON doctors (clinic_id);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS doctor_review_status TEXT CHECK (doctor_review_status IN ('pending','approved','needs_info')),
  ADD COLUMN IF NOT EXISTS doctor_note TEXT,
  ADD COLUMN IF NOT EXISTS doctor_reviewed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_leads_doctor ON leads (doctor_id) WHERE doctor_id IS NOT NULL;

-- ── operation_costs (multi-currency cost tracking — see 018_operation_costs.sql)
CREATE TABLE IF NOT EXISTS operation_costs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  category    TEXT NOT NULL CHECK (category IN ('hospital','driver','hotel','other')),
  amount      NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  currency    TEXT NOT NULL DEFAULT 'TRY',
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_operation_costs_lead ON operation_costs (lead_id, created_at DESC);

-- Patient-facing live itinerary link (see 019_itinerary.sql).
ALTER TABLE logistics
  ADD COLUMN IF NOT EXISTS pickup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pickup_location TEXT,
  ADD COLUMN IF NOT EXISTS next_appointment_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_appointment_note TEXT,
  ADD COLUMN IF NOT EXISTS view_token TEXT UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex');

-- ── AI Maliyet Panosu (see 023_ai_cost_tracking.sql) ───────────────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS llm_input_tokens       INTEGER,
  ADD COLUMN IF NOT EXISTS llm_output_tokens      INTEGER,
  ADD COLUMN IF NOT EXISTS llm_cached_read_tokens INTEGER;
