-- Real payment-gateway checkout links on top of the existing manual
-- payments table (bank-transfer style logging stays available — this is
-- additive). A patient can now get a Stripe-hosted checkout link instead of
-- an IBAN in a chat message; the webhook confirms it was actually paid.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/021_payment_gateway.sql

ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_url text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_session_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS link_sent_at timestamptz;

-- Lets the webhook look a session back up if it ever needs to (client_reference_id
-- is the primary lookup path — see markPaymentPaidByWebhook), and stops the
-- same Stripe session from ever being attached to two different payments.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_session
  ON payments (provider_session_id) WHERE provider_session_id IS NOT NULL;
