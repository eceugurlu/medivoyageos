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

-- ── Devir SLA Alarmı (see 023_handover_sla.sql) ────────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS escalated_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_first_reminder_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_escalated_at        TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_conversations_needs_human_escalated
  ON conversations (escalated_at) WHERE status = 'needs_human';

-- ── Haftalık Sonuç Raporu (see 024_weekly_report.sql) ──────────────────────
ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS last_weekly_report_sent_at TIMESTAMPTZ;

-- ── AI Maliyet Panosu (see 025_ai_cost_tracking.sql) ───────────────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS llm_input_tokens       INTEGER,
  ADD COLUMN IF NOT EXISTS llm_output_tokens      INTEGER,
  ADD COLUMN IF NOT EXISTS llm_cached_read_tokens INTEGER;

-- ── Sesli AI Konsiyerj (Voice AI Call Center — bkz. 026_voice_calls.sql) ───
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS twilio_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_twilio_number
  ON branches (twilio_number) WHERE twilio_number IS NOT NULL;

ALTER TABLE coordinators
  ADD COLUMN IF NOT EXISTS phone TEXT;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS voice_recording_consent BOOLEAN,
  ADD COLUMN IF NOT EXISTS voice_outbound_consent  BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS calls (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id              UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  branch_id              UUID REFERENCES branches(id) ON DELETE SET NULL,
  lead_id                UUID REFERENCES leads(id) ON DELETE SET NULL,
  provider_call_id       TEXT NOT NULL,
  direction              TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  status                 TEXT NOT NULL DEFAULT 'in_progress'
                            CHECK (status IN ('in_progress','completed','failed','no_answer','voicemail','busy')),
  language               TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at               TIMESTAMPTZ,
  duration_s             INTEGER,
  recording_consent      BOOLEAN,
  recording_url          TEXT,
  outcome                TEXT,
  summary                TEXT,
  score                  INTEGER CHECK (score BETWEEN 0 AND 100),
  handover_reason        TEXT,
  urgent                 BOOLEAN NOT NULL DEFAULT false,
  medical_note           TEXT,
  force_handover_requested_at TIMESTAMPTZ,
  telephony_seconds      INTEGER NOT NULL DEFAULT 0,
  stt_seconds            INTEGER NOT NULL DEFAULT 0,
  llm_input_tokens       INTEGER NOT NULL DEFAULT 0,
  llm_output_tokens      INTEGER NOT NULL DEFAULT 0,
  llm_cached_read_tokens INTEGER NOT NULL DEFAULT 0,
  tts_characters         INTEGER NOT NULL DEFAULT 0,
  cost_breakdown         JSONB,
  total_cost_usd         NUMERIC(10,4),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_provider_call_id ON calls (provider_call_id);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls (lead_id, started_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_clinic_started ON calls (clinic_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status_live ON calls (status) WHERE status = 'in_progress';

CREATE TABLE IF NOT EXISTS call_turns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id         UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('patient','assistant','system')),
  transcript      TEXT NOT NULL,
  is_safety_net   BOOLEAN NOT NULL DEFAULT false,
  turn_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  latency_ms      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_call_turns_call ON call_turns (call_id, turn_started_at);

CREATE TABLE IF NOT EXISTS call_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('hot_callback','silence_escalation','post_op_checkin','noshow_confirm')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','calling','done','failed','voicemail','cancelled')),
  scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  last_attempt_at TIMESTAMPTZ,
  last_outcome    TEXT,
  call_id         UUID REFERENCES calls(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_jobs_due ON call_jobs (scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_call_jobs_lead ON call_jobs (lead_id, created_at DESC);

-- ── Reklam → Hasta Atfetme Zinciri (see 027_campaign_attribution.sql) ─────
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS external_ref TEXT,
  ADD COLUMN IF NOT EXISTS active       BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_external_ref
  ON campaigns (clinic_id, external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS campaign_id      UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ad_source_id     TEXT,
  ADD COLUMN IF NOT EXISTS ad_source_type   TEXT,
  ADD COLUMN IF NOT EXISTS ad_source_url    TEXT,
  ADD COLUMN IF NOT EXISTS ad_headline      TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_clid        TEXT,
  ADD COLUMN IF NOT EXISTS attributed_at    TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_ad_source ON leads (ad_source_id) WHERE ad_source_id IS NOT NULL;

-- ── Klinik Risk & Uyum Skoru (see 028_compliance_risk.sql) ─────────────────
CREATE TABLE IF NOT EXISTS compliance_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
                'health_tourism_authorization', 'accreditation',
                'complication_insurance', 'kvkk_registry', 'call_center_contract'
              )),
  status      TEXT NOT NULL DEFAULT 'missing'
                CHECK (status IN ('missing','in_progress','valid','expired')),
  reference   TEXT, issuer TEXT,
  valid_from  DATE, valid_until DATE,
  verified_at TIMESTAMPTZ,                       -- NULL = sadece klinik beyanı
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_clinic_kind
  ON compliance_records (clinic_id, kind);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS operated_at         DATE,
  ADD COLUMN IF NOT EXISTS outcome_status      TEXT,
  ADD COLUMN IF NOT EXISTS outcome_recorded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome_note        TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_outcome_status_check') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_outcome_status_check
      CHECK (outcome_status IS NULL OR outcome_status IN (
        'recovering','recovered','complication','revision_needed','lost_contact'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_leads_operated ON leads (operated_at DESC)
  WHERE operated_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_outcome ON leads (outcome_status)
  WHERE outcome_status IS NOT NULL;

-- ── Meta Conversions API kuyruğu (see 029_conversion_events.sql) ───────────
CREATE TABLE IF NOT EXISTS conversion_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id     UUID REFERENCES leads(id) ON DELETE SET NULL,
  event_name  TEXT NOT NULL,
  dedup_key   TEXT NOT NULL,          -- olayı tetikleyen satırın kimliği
  channel     TEXT,
  value       NUMERIC(12,2),
  currency    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','failed','skipped')),
  skip_reason TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  payload     JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversion_events_dedup
  ON conversion_events (clinic_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_conversion_events_pending
  ON conversion_events (occurred_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_conversion_events_lead
  ON conversion_events (lead_id, created_at DESC) WHERE lead_id IS NOT NULL;

-- ── Sonuç Pasaportu (see 030_outcome_passport.sql) ─────────────────────────
CREATE TABLE IF NOT EXISTS passports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
  view_token        TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  procedure_name    TEXT,
  procedure_date    DATE,
  anesthesia        TEXT,
  implants          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{type,brand,model,lot,side,note}]
  medications       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{name,dose,duration}]
  aftercare         TEXT,
  warning_signs     TEXT,
  emergency_contact TEXT,
  content_language  TEXT,
  issued_at         TIMESTAMPTZ,   -- NULL = taslak, token 404 döner
  revoked_at        TIMESTAMPTZ,   -- dolu = link ölü
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_passports_lead ON passports (lead_id);
CREATE INDEX IF NOT EXISTS idx_passports_live ON passports (view_token)
  WHERE issued_at IS NOT NULL AND revoked_at IS NULL;

-- ── Rakip cevap süresi araştırması (see 031_benchmark_probes.sql) ──────────
-- Ürün verisi değil, saha ölçümü. Klinik İSMİ tutulmaz: label anonim etiket.
CREATE TABLE IF NOT EXISTS benchmark_probes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('whatsapp','instagram','web_form','phone','email')),
  city           TEXT, treatment TEXT, language TEXT,
  sent_at        TIMESTAMPTZ NOT NULL,
  first_reply_at TIMESTAMPTZ,   -- NULL + 48sa geçti = "cevap vermedi" (sorguda)
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT benchmark_probes_reply_after_send
    CHECK (first_reply_at IS NULL OR first_reply_at >= sent_at)
);
CREATE INDEX IF NOT EXISTS idx_benchmark_probes_clinic ON benchmark_probes (clinic_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_probes_open ON benchmark_probes (sent_at)
  WHERE first_reply_at IS NULL;

-- ── Ücretsiz Uyum Kontrolü (see 032_compliance_checks.sql) ────────────────
-- Kamuya açık öz değerlendirme. Her şey BEYANDIR; paneldeki Risk & Uyum
-- skoru ise kliniğin kendi verisinden ÖLÇÜLÜR. İkisi karıştırılmamalı.
CREATE TABLE IF NOT EXISTS compliance_checks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_name TEXT, email TEXT, city TEXT,
  answers     JSONB NOT NULL,
  score       INTEGER,        -- NULL olabilir: hiç cevap yoksa skor da yok
  coverage    NUMERIC(4,3),
  gap_count   INTEGER NOT NULL DEFAULT 0,
  source      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_checks_created ON compliance_checks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_checks_lead ON compliance_checks (created_at DESC)
  WHERE email IS NOT NULL;
