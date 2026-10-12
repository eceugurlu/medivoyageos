-- Security fix: partner.html was building the partner's PUBLIC "share this"
-- referral link out of the SAME token used to log into their PRIVATE
-- dashboard (partners.api_token) — anyone who saw the referral link (posted
-- on the partner's own site, screenshotted, etc.) could use it to read that
-- partner's full portal: every referred patient's name/treatment/amount and
-- the partner's own commission. This adds a separate, non-secret referral
-- code — safe to publish — distinct from the portal auth token.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/022_partner_referral_code.sql

ALTER TABLE partners ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;

-- Backfill existing partners so nobody's referral link breaks.
UPDATE partners SET referral_code = encode(gen_random_bytes(8), 'hex') WHERE referral_code IS NULL;

ALTER TABLE partners ALTER COLUMN referral_code SET NOT NULL;
