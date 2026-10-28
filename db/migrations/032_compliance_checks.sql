-- Ücretsiz Uyum Kontrolü — kamuya açık öz değerlendirme kayıtları.
--
-- Pazarlama aracı ve ürün vitrini: klinik 10 soruya cevap verir, karşısına
-- yönetmelik karşısındaki durumu ve akreditasyona kalan gün sayısı çıkar.
-- Aynı skor motorunun (services/compliance.js) kuralları geçerli: cevaplanmamış
-- madde 0 puan değil, kapsam dışıdır.
--
-- ÖNEMLİ FARK: buradaki her şey BEYANDIR. Panel içindeki Risk & Uyum skoru
-- kliniğin kendi verisinden ölçülür; bu sayfa yalnızca kliniğin söylediğini
-- puanlar. Sonuç ekranı bunu açıkça yazar ve ürünün satış argümanı tam
-- burada: "beyanınız bu; ölçülmüş hâli farklı olabilir."
--
-- E-posta ZORUNLU DEĞİL. Sonucu görmek için e-posta istemek daha çok kayıt
-- toplar ama kliniğin işine yarayan şeyi rehin almak olurdu; e-posta yalnızca
-- detaylı rapor isteyenden alınıyor.

CREATE TABLE IF NOT EXISTS compliance_checks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_name  TEXT,                  -- kliniğin kendi yazdığı ad (isteğe bağlı)
  email        TEXT,                  -- yalnızca detaylı rapor isteyenlerde
  city         TEXT,
  answers      JSONB NOT NULL,        -- ham cevaplar, skorun yeniden üretilebilmesi için
  score        INTEGER,               -- NULL olabilir: hiç cevap yoksa skor da yok
  coverage     NUMERIC(4,3),          -- ölçülebilen ağırlığın oranı
  gap_count    INTEGER NOT NULL DEFAULT 0,
  source       TEXT,                  -- utm/kampanya izi (isteğe bağlı)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_checks_created ON compliance_checks (created_at DESC);
-- E-posta bırakanlar potansiyel müşteri listesidir; ayrı indeks onu
-- taramadan çıkarmak için.
CREATE INDEX IF NOT EXISTS idx_compliance_checks_lead ON compliance_checks (created_at DESC)
  WHERE email IS NOT NULL;
