-- Multi-currency cost tracking & net profitability. `payments` is money IN
-- (what the patient owes/paid); this is money OUT (what the clinic pays
-- the hospital, driver, hotel per case) — different enough in shape and
-- meaning that reusing `payments` would have meant overloading its status
-- vocabulary (pending/paid/refunded means something different for a cost).
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/018_operation_costs.sql

CREATE TABLE IF NOT EXISTS operation_costs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  category    text NOT NULL CHECK (category IN ('hospital','driver','hotel','other')),
  amount      numeric(10,2) NOT NULL CHECK (amount > 0),
  currency    text NOT NULL DEFAULT 'TRY',
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_operation_costs_lead ON operation_costs (lead_id, created_at DESC);
