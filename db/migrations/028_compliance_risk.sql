-- Klinik Risk & Uyum Skoru.
--
-- İki ayrı soruyu tek ekranda cevaplar:
--   1) UYUM  — klinik 26.04.2025 tarihli Sağlık Turizmi Yönetmeliği'nin
--      (RG 32882) gerekliliklerini karşılıyor mu? Akreditasyon son tarihi
--      31.12.2026; komplikasyon sigortası 01.01.2026'dan beri zorunlu.
--   2) RİSK  — kliniğin gerçek sonuç verisi ne söylüyor? Komplikasyon oranı,
--      ameliyat sonrası takip uyumu, devir cevap süresi.
--
-- (2) bugün sektörde hiç yok: zorunlu komplikasyon sigortası var ama
-- sigortacının fiyatlayacağı klinik bazlı hasar verisi yok. Bu tablolar o
-- veriyi üretir. Skor hesabı src/services/compliance.js içinde, saf fonksiyon.
--
-- ÖNEMLİ: belge durumları (akreditasyon, poliçe) kliniğin BEYANIdır —
-- doğrulanmış değil. compliance_records.verified_at bunu açıkça ayırır;
-- panel beyan ile ölçüm arasındaki farkı gizlemez.

CREATE TABLE IF NOT EXISTS compliance_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
                'health_tourism_authorization',  -- sağlık turizmi yetki belgesi
                'accreditation',                 -- akreditasyon (son tarih 31.12.2026)
                'complication_insurance',        -- zorunlu komplikasyon sigortası
                'kvkk_registry',                 -- VERBİS kaydı
                'call_center_contract'           -- 7/24 çok dilli çağrı merkezi
              )),
  status      TEXT NOT NULL DEFAULT 'missing'
                CHECK (status IN ('missing','in_progress','valid','expired')),
  reference   TEXT,                              -- belge / poliçe numarası
  issuer      TEXT,                              -- akreditasyon kurumu, sigorta şirketi
  valid_from  DATE,
  valid_until DATE,
  verified_at TIMESTAMPTZ,                       -- NULL = sadece klinik beyanı
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Belge türü başına tek kayıt: upsert anahtarı.
CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_clinic_kind
  ON compliance_records (clinic_id, kind);

-- Sonuç verisi. leads.doctor_id 017'de geldi; doktor bazlı kırılım onunla çalışır.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS operated_at         DATE,
  ADD COLUMN IF NOT EXISTS outcome_status      TEXT,
  ADD COLUMN IF NOT EXISTS outcome_recorded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome_note        TEXT;

-- CHECK'i ayrı ekliyoruz: ADD COLUMN IF NOT EXISTS ile inline CHECK, kolon
-- zaten varsa sessizce atlanır ve kısıt hiç kurulmaz.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_outcome_status_check'
  ) THEN
    ALTER TABLE leads ADD CONSTRAINT leads_outcome_status_check
      CHECK (outcome_status IS NULL OR outcome_status IN (
        'recovering',       -- iyileşme sürecinde
        'recovered',        -- sorunsuz iyileşti
        'complication',     -- komplikasyon gelişti
        'revision_needed',  -- revizyon gerekiyor
        'lost_contact'      -- iletişim koptu (sonuç bilinmiyor)
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_leads_operated ON leads (operated_at DESC)
  WHERE operated_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_outcome ON leads (outcome_status)
  WHERE outcome_status IS NOT NULL;
