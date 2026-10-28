-- Meta Conversions API — giden olay kuyruğu (outbox).
--
-- Zincirin son halkası. 027 reklamdan hastaya olan yolu açtı; bu, sonucu
-- Meta'ya GERİ besler. Meta'nın algoritması hangi tıklamanın ameliyata
-- döndüğünü öğrenince reklamı o kitleye optimize eder. Klinik aynı bütçeyle
-- daha çok hasta alır — ve bunu yapabilmek için elinde ctwa_clid ile ödeme
-- kaydını aynı anda tutması gerekir, ki bu bizde var.
--
-- Neden kuyruk, neden "gönder ve unut" değil:
--   1) Meta geçersiz payload'a 4xx döner ve ayrıntı vermez. Ne gönderdiğimizi
--      saklamazsak neyin reddedildiğini asla öğrenemeyiz.
--   2) Ödeme webhook'u iki kez gelirse Purchase iki kez gider ve kliniğin
--      ROAS'ı şişer. dedup_key bunu veritabanı seviyesinde imkânsız kılar.
--   3) Gönderemediğimiz olay (ctwa_clid yok) sessizce kaybolmamalı; 'skipped'
--      olarak NEDENİYLE durur, panelde görünür. Atfetmenin nerede koptuğunu
--      ancak böyle bilebiliriz.
--
-- Alan adları Meta'nın kendi dokümanından (Conversions API for Business
-- Messaging, v26.0): action_source='business_messaging', messaging_channel,
-- user_data.ctwa_clid (HASH'LENMEZ — yalnızca em/ph gibi müşteri bilgileri
-- SHA-256 ister).

CREATE TABLE IF NOT EXISTS conversion_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id     UUID REFERENCES leads(id) ON DELETE SET NULL,
  event_name  TEXT NOT NULL,          -- Purchase | LeadSubmitted | QualifiedLead …
  -- Tekilleştirme anahtarı. Olayı tetikleyen SATIRIN kimliğini taşır
  -- (ör. 'purchase:<payment_id>'), zamanı değil: aynı ödeme ikinci kez
  -- bildirilse de anahtar aynıdır ve ikinci satır hiç oluşmaz.
  dedup_key   TEXT NOT NULL,
  channel     TEXT,                   -- whatsapp | instagram | messenger
  value       NUMERIC(12,2),
  currency    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','failed','skipped')),
  skip_reason TEXT,                   -- neden gönderilemedi (ör. ctwa_clid yok)
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  payload     JSONB,                  -- Meta'ya giden gövde, gönderildiği haliyle
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
