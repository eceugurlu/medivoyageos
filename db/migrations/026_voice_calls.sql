-- ─────────────────────────────────────────────────────────────────────────
-- Sesli AI Konsiyerj (Voice AI Call Center) — Twilio PSTN + Deepgram STT +
-- Claude (streaming) + ElevenLabs TTS.
--
-- Mevcut leads/conversations/messages şemasına DOKUNMAZ: conversations lead
-- başına tekildir (UNIQUE(lead_id)), bu yüzden çağrı geçmişi kendi
-- tablolarında (calls/call_turns) tutulur. Lead eşleşmesi mevcut
-- (clinic_id, phone) anahtarıyla otomatik olur — bkz. repository.js
-- loadContext()/resolveLeadForCall(): WhatsApp'tan tanınan bir numara
-- aradığında aynı lead'e bağlanır, özel bir birleştirme kodu gerekmez.
--
-- Çalıştırmak için:
--   psql "$DATABASE_URL" -f db/migrations/026_voice_calls.sql
-- ─────────────────────────────────────────────────────────────────────────

-- ── şube/koordinatör telefon alanları (mevcut boşluklar) ───────────────────
-- Aranan numara → şube eşlemesi (hangi klinik/şube profili, mesai saati,
-- devir numarası kullanılacağını belirler).
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS twilio_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_twilio_number
  ON branches (twilio_number) WHERE twilio_number IS NOT NULL;

-- Sıcak devir (warm transfer) için gerçek, aranabilir telefon numarası —
-- coordinators tablosunda şimdiye kadar hiç yoktu.
ALTER TABLE coordinators
  ADD COLUMN IF NOT EXISTS phone TEXT;

-- ── hasta onam alanları (metin kanalındaki genel `consent`tan ayrı) ────────
-- Sesli görüşme KAYDI için onam (NULL = henüz sorulmadı — arama başında
-- sorulur) ve giden (outbound) arama için açık onam, ikisi de ayrı sinyaller.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS voice_recording_consent BOOLEAN,
  ADD COLUMN IF NOT EXISTS voice_outbound_consent  BOOLEAN NOT NULL DEFAULT false;

-- ── calls: bir telefon görüşmesi = bir satır ───────────────────────────────
CREATE TABLE IF NOT EXISTS calls (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id              UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  branch_id              UUID REFERENCES branches(id) ON DELETE SET NULL,
  lead_id                UUID REFERENCES leads(id) ON DELETE SET NULL, -- ilk saniyelerde NULL olabilir
  provider_call_id       TEXT NOT NULL,              -- Twilio CallSid — idempotency anahtarı
  direction              TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  status                 TEXT NOT NULL DEFAULT 'in_progress'
                            CHECK (status IN ('in_progress','completed','failed','no_answer','voicemail','busy')),
  language               TEXT,                       -- tespit edilen/son dil (ISO kodu)
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at               TIMESTAMPTZ,
  duration_s             INTEGER,
  recording_consent      BOOLEAN,                    -- görüşme başındaki KVKK/GDPR bildirimine verilen yanıt
  recording_url          TEXT,                        -- consent=true ise; false ise ses hiç saklanmaz
  outcome                TEXT,                        -- booked|handed_over|followup_promised|no_action|voicemail_left ...
  summary                TEXT,                        -- çağrı sonu özet (AI üretimi)
  score                  INTEGER CHECK (score BETWEEN 0 AND 100),
  handover_reason        TEXT,
  urgent                 BOOLEAN NOT NULL DEFAULT false,
  medical_note           TEXT,
  force_handover_requested_at TIMESTAMPTZ,           -- panelden "canlı çağrıyı devral" — session.js tur arasında okur
  -- maliyet: ham kullanım + hesaplandığı anın fiyatlarıyla dondurulmuş toplam
  -- (fiyat config'i ileride değişse de geçmiş görüşmenin rakamı değişmesin).
  telephony_seconds      INTEGER NOT NULL DEFAULT 0,
  stt_seconds             INTEGER NOT NULL DEFAULT 0,
  llm_input_tokens       INTEGER NOT NULL DEFAULT 0,
  llm_output_tokens      INTEGER NOT NULL DEFAULT 0,
  llm_cached_read_tokens INTEGER NOT NULL DEFAULT 0,
  tts_characters         INTEGER NOT NULL DEFAULT 0,
  cost_breakdown         JSONB,                       -- {telephony,stt,llm,tts} USD
  total_cost_usd         NUMERIC(10,4),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Twilio webhook'ları en-az-bir-kez teslim eder; aynı CallSid'in iki kez
-- işlenmemesi (örn. /voice/status tekrar tetiklenirse) bu tekil indeksle
-- garanti edilir — idx_messages_wamid/idx_payments_provider_session ile aynı desen.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_provider_call_id ON calls (provider_call_id);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls (lead_id, started_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_clinic_started ON calls (clinic_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status_live ON calls (status) WHERE status = 'in_progress';

-- ── call_turns: çağrı içindeki her konuşma turu (messages'ın sesli karşılığı) ──
CREATE TABLE IF NOT EXISTS call_turns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id         UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('patient','assistant','system')), -- system: açılış bildirimi/güvenlik betiği
  transcript      TEXT NOT NULL,
  is_safety_net   BOOLEAN NOT NULL DEFAULT false,     -- scanForSafetySignal() tetiklediyse true
  turn_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  latency_ms      INTEGER                             -- bu tur için konuşma-bitti → ilk-ses-baytı gecikmesi
);
CREATE INDEX IF NOT EXISTS idx_call_turns_call ON call_turns (call_id, turn_started_at);

-- ── call_jobs: giden çağrı kuyruğu (Faz 2) — scheduler.js'teki atomik-claim
-- deseniyle aynı: UPDATE ... WHERE status='pending' RETURNING id. Henüz hiçbir
-- kod bu tabloyu okumuyor/yazmıyor (Faz 2'de scheduler.js'e eklenecek); şema
-- şimdiden hazırlanıyor ki migration numaraları ileride bölünmesin.
CREATE TABLE IF NOT EXISTS call_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('hot_callback','silence_escalation','post_op_checkin','noshow_confirm')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','calling','done','failed','voicemail','cancelled')),
  scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT now(), -- hasta-yerel 09:00–20:00 penceresine göre hesaplanır
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
