-- Depozito ve ödeme takibi. Bu tablo olmadan gelir/ROAS/CAC gerçek değil,
-- rezervasyonlu lead sayısı × varsayılan bir ortalama değerdi (bkz. eski
-- AVG_VALUE sabiti, repository.js). Artık analytics gerçekten ödenmiş
-- tutarların toplamından hesaplanıyor.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/009_payments.sql

CREATE TABLE IF NOT EXISTS payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  amount            numeric(10,2) NOT NULL CHECK (amount > 0),
  currency          text NOT NULL DEFAULT 'EUR',
  type              text NOT NULL DEFAULT 'deposit' CHECK (type IN ('deposit','balance','full')),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','refunded')),
  due_date          date,                 -- when the clinic expects to be paid
  paid_at           timestamptz,          -- when status actually became 'paid'
  reminder_sent_at  timestamptz,          -- last time a coordinator flagged a nudge
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_lead   ON payments (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status) WHERE status = 'pending';
