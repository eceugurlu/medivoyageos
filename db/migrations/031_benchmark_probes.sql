-- Rakip cevap süresi ölçümü.
--
-- Bu tablo bir ürün özelliği değil, SAHA ARAŞTIRMASI kaydı: kurucunun
-- kliniklere kendi attığı mesajların ne kadar sürede cevaplandığı. Sektörde
-- yayınlanmış bir "ortalama cevap süresi" yok; bu kayıt onu üretiyor ve
-- ürünün kendi ölçümüyle (bkz. getResponseTimes) yan yana konabilir hâle
-- getiriyor. Yani "biz hızlıyız" iddiası değil, iki ölçümün karşılaştırması.
--
-- Klinik İSMİ tutulmuyor, bilerek. Rakip bir kliniğin cevap süresini adıyla
-- yayımlamak hem gereksiz hem riskli; araştırmanın değeri dağılımda, tek
-- tek kliniklerde değil. label yalnızca kurucunun kendi takibi için
-- ("Klinik A", "Saç ekimi 3") ve anonim kalmalı.

CREATE TABLE IF NOT EXISTS benchmark_probes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,                 -- anonim etiket, gerçek isim DEĞİL
  channel        TEXT NOT NULL CHECK (channel IN ('whatsapp','instagram','web_form','phone','email')),
  city           TEXT,
  treatment      TEXT,
  language       TEXT,                          -- mesajın yazıldığı dil
  sent_at        TIMESTAMPTZ NOT NULL,
  -- NULL = henüz cevap gelmedi. "Hiç cevap vermedi"ye çevirmek için ayrı bir
  -- kolon yok: eşik (48 saat) sorgu tarafında uygulanıyor, böylece dün
  -- gönderilmiş bir mesaj "cevapsız" sayılıp oranı bozmuyor.
  first_reply_at TIMESTAMPTZ,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Aynı kliniğe aynı kanaldan iki kez ölçüm yapılabilir ama aynı anda değil.
  CONSTRAINT benchmark_probes_reply_after_send
    CHECK (first_reply_at IS NULL OR first_reply_at >= sent_at)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_probes_clinic ON benchmark_probes (clinic_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_probes_open ON benchmark_probes (sent_at)
  WHERE first_reply_at IS NULL;
