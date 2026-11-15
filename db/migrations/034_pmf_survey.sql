-- Sean Ellis PMF Sorusu.
--
-- "Bu ürünü artık kullanamasaydınız ne hissederdiniz?" — ürün/pazar uyumunu
-- ölçmenin standart yöntemi (Sean Ellis, Superhuman'ın büyüme ekibinin de
-- kullandığı test). Eşik literatürde sabit: "çok hayal kırıklığına uğrarım"
-- diyenlerin oranı %40'ı geçerse güçlü bir PMF sinyali sayılır.
--
-- Koordinatörler ayrı kimlik doğrulamasına sahip değil (bkz. coordinators
-- tablosu — api_token yok, doctor/partner portallarının aksine); panel tek
-- bir PANEL_API_TOKEN ile korunuyor. Bu yüzden coordinator_id İSTEĞE BAĞLI:
-- kim olduğunu seçmek anketi daha anlamlı kılar ama zorunlu tutmak, ekibi
-- küçük kliniklerde anonimliği (ve dolayısıyla dürüst cevabı) bozar.

CREATE TABLE IF NOT EXISTS pmf_survey_responses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  coordinator_id UUID REFERENCES coordinators(id) ON DELETE SET NULL,
  answer         TEXT NOT NULL CHECK (answer IN ('very_disappointed','somewhat_disappointed','not_disappointed')),
  reason         TEXT,  -- isteğe bağlı: "en çok ne için kullanıyorsunuz" (Sean Ellis'in ikinci sorusu)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pmf_survey_clinic ON pmf_survey_responses (clinic_id, created_at DESC);
