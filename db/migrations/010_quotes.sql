-- Yapılandırılmış tedavi teklifleri (Treatment Plan Builder). Toplam tutar
-- her zaman sunucuda kalemlerden hesaplanır — client'tan gelen bir toplama
-- güvenilmez, aynı payments.amount'un elle yazılmaması gibi.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/010_quotes.sql

CREATE TABLE IF NOT EXISTS quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  items         jsonb NOT NULL DEFAULT '[]',   -- [{label, qty, unit_price}, ...]
  total_amount  numeric(10,2) NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'EUR',
  language      text NOT NULL DEFAULT 'en',    -- PDF'in üretileceği dil
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','viewed','accepted')),
  valid_until   date,
  -- Hastanın tıkladığı izlenebilir link bu token'a dayanır; tahmin edilemez
  -- olması için pgcrypto'nun rastgele baytlarından üretilir.
  view_token    text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  viewed_at     timestamptz,
  accepted_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_quotes_lead  ON quotes (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_token ON quotes (view_token);
