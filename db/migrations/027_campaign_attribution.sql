-- ─────────────────────────────────────────────────────────────────────────
-- Reklam → Hasta Atfetme Zinciri (kampanya bazlı CAC/ROAS)
--
-- Bugüne kadar panel kendi kendini ele veriyordu: "CAC ve ROAS toplamdır,
-- kanal bazlı değildir... bir lead'in nasıl geldiğini kaydeder, hangi
-- kampanyanın parasını ödediğini değil." leads.source yalnızca TAŞIYICIYI
-- (whatsapp/widget/instagram) söylüyordu, ÖDEYENİ değil — yani hiçbir
-- rezervasyon, onu üreten reklama kadar geri izlenemiyordu.
--
-- Bu migration eksik halkayı ekler: her lead, geldiği reklama/kampanyaya
-- bağlanır, böylece "bu Instagram kampanyası 40 lead getirdi, 3'ü ameliyat
-- oldu, €3.900 gelir, CAC €175" cümlesi kurulabilir hale gelir.
--
-- Çalıştırmak için:
--   psql "$DATABASE_URL" -f db/migrations/027_campaign_attribution.sql
-- ─────────────────────────────────────────────────────────────────────────

-- ── campaigns: reklam platformundaki gerçek kimliğiyle eşleşme ──────────
-- external_ref = Meta'nın reklam kimliği (webhook'taki referral.source_id)
-- ya da widget linkindeki utm_campaign değeri. Bir kampanyanın harcaması
-- zaten campaigns.spend'de; eksik olan, gelen lead'i BU satıra bağlamaktı.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS external_ref TEXT,
  ADD COLUMN IF NOT EXISTS active       BOOLEAN NOT NULL DEFAULT true;

-- Aynı reklam kimliği bir klinikte iki kampanya satırına bağlanamaz —
-- yoksa atfetme sessizce ikiye bölünür ve CAC olduğundan iyi görünür.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_external_ref
  ON campaigns (clinic_id, external_ref) WHERE external_ref IS NOT NULL;

-- ── leads: lead'in geldiği reklamın ham kanıtı ──────────────────────────
-- campaign_id çözülmüş eşleşme; ham alanlar ise eşleşme kurulamasa bile
-- (henüz panelde tanımlanmamış yeni bir reklam) veriyi KAYBETMEMEK için
-- saklanır — kampanya sonradan tanımlandığında geriye dönük eşleştirilebilir.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS campaign_id      UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ad_source_id     TEXT,   -- Meta referral.source_id / utm_campaign
  ADD COLUMN IF NOT EXISTS ad_source_type   TEXT,   -- 'ad' | 'post' | 'utm' | 'referral_code'
  ADD COLUMN IF NOT EXISTS ad_source_url    TEXT,   -- referral.source_url / landing page
  ADD COLUMN IF NOT EXISTS ad_headline      TEXT,   -- referral.headline — hangi YARATICI işe yaradı
  -- Meta Conversions API'ye "bu tıklama ameliyata dönüştü" geri bildirimi
  -- göndermek için gereken tıklama kimliği. Meta'nın kendi dokümanı: WhatsApp
  -- Status yerleşiminden gelen mesajlarda bu alan HİÇ gelmez, o yüzden
  -- NULL olabilir ve atfetme buna bağımlı olmamalı (source_id yeterli).
  ADD COLUMN IF NOT EXISTS ctwa_clid        TEXT,
  ADD COLUMN IF NOT EXISTS attributed_at    TIMESTAMPTZ;

-- Atfetme yalnızca İLK temasta yazılır (bkz. repository.js attachLeadAttribution):
-- hasta aylar sonra ikinci bir reklama tıklarsa ilk kaynak korunur, yoksa
-- son tıklama her şeyi sahiplenir ve huninin başı görünmez olur.
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_ad_source ON leads (ad_source_id) WHERE ad_source_id IS NOT NULL;
