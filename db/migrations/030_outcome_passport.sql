-- Sonuç Pasaportu (Outcome Passport).
--
-- Hasta ameliyattan 4-5 gün sonra uçup gidiyor ve ülkesindeki doktor hiçbir
-- şey bilmiyor: ne yapıldı, hangi implant takıldı, hangi ilaç verildi, hangi
-- komplikasyon beklenir. 2019'dan beri 22 İngiliz vatandaşının öldüğü
-- bildirildi ve bir adli tabip raporu tam bu bilgi boşluğunu sorguladı.
-- Sektörün en büyük yükümlülüğü bu; pasaport onu ürüne çevirir.
--
-- Tasarımın iki sert kuralı:
--   1) YAYINLANMADAN görünmez. issued_at boşken token 404 döner. Yarım
--      doldurulmuş bir kaydın yabancı bir acil servise ulaşması, hiç
--      kayıt olmamasından kötüdür.
--   2) Geri alınabilir. revoked_at dolunca link ölür — yanlış lot numarası
--      girilmiş bir implant kaydı dünyada dolaşmaya devam edemez.
--
-- Klinik içeriği ÇEVİRMİYORUZ. Etiketler çok dilli (yabancı hekimin
-- ihtiyacı olan şey "implant lot numarası" alanının hangisi olduğunu
-- anlamak; lot numarasının kendisi dil-bağımsız). Serbest metin alanları
-- kliniğin yazdığı dilde kalır ve sayfada bu açıkça yazar: makine çevirisi
-- bir tıbbi kayıt gibi sunulamaz.

CREATE TABLE IF NOT EXISTS passports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
  view_token        TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  procedure_name    TEXT,                 -- GERÇEKTE yapılan işlem (leads.treatment_interest "ilgi"dir, bu değil)
  procedure_date    DATE,
  anesthesia        TEXT,
  -- [{ type, brand, model, lot, side, note }] — lot/seri numarası, yabancı
  -- hekimin geri çağırma (recall) kontrolü için tek işe yarar alan.
  implants          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{ name, dose, duration }]
  medications       JSONB NOT NULL DEFAULT '[]'::jsonb,
  aftercare         TEXT,                 -- klinik ne yazdıysa, o dilde
  warning_signs     TEXT,                 -- "şu belirtilerde derhal doktora git"
  emergency_contact TEXT,
  content_language  TEXT,                 -- serbest metinlerin dili (çeviri YOK, etiketlemek için)
  issued_at         TIMESTAMPTZ,          -- NULL = taslak, token 404
  revoked_at        TIMESTAMPTZ,          -- dolu = link ölü
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_passports_lead ON passports (lead_id);
-- Token araması yalnızca yayınlanmış ve geri alınmamış kayıtlar için
-- anlamlı; kısmi indeks hem küçük hem de niyeti belgeliyor.
CREATE INDEX IF NOT EXISTS idx_passports_live ON passports (view_token)
  WHERE issued_at IS NOT NULL AND revoked_at IS NULL;
