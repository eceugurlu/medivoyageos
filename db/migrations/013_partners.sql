-- Partner (referral) desteği. Partnerler kendi api_token'larıyla Partner
-- Portalı'na girip yönlendirdikleri lead'leri ve kazandıkları komisyonu görür.
-- Komisyon, o partnerin lead'lerinden GERÇEKTEN tahsil edilmiş (payments.status
-- = 'paid') tutar üzerinden hesaplanır — getPaymentTotals'daki "paid, booked
-- değil" disiplininin aynısı.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/013_partners.sql

CREATE TABLE IF NOT EXISTS partners (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name             text NOT NULL,
  email            text,
  api_token        text NOT NULL UNIQUE,
  commission_rate  numeric(5,2) NOT NULL DEFAULT 10.00 CHECK (commission_rate >= 0 AND commission_rate <= 100),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partners_clinic ON partners (clinic_id);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_partner ON leads (partner_id)
  WHERE partner_id IS NOT NULL;
