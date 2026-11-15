-- 1 Günde Kurulum Kontrol Listesi.
--
-- "Yarın başlarsınız" diyebilmek için: yeni bir kliniğin gerçekten bir
-- günde kurulup kurulamadığını somut adımlara böler. Bazı adımlar
-- OTOMATİK ölçülür (en az bir şube var mı, WhatsApp bağlı mı — gerçek
-- veriden, bu tabloya hiç yazılmadan); bazıları (ekibin eğitilmesi gibi)
-- ölçülemez ve yalnızca elle işaretlenir. Bu tablo SADECE elle işaretlenen
-- adımları tutar — otomatik olanlar için satır YOKTUR, çünkü onlar zaten
-- gerçek veriden her istekte yeniden hesaplanıyor (bkz. services/setupChecklist.js).

CREATE TABLE IF NOT EXISTS setup_checklist_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  item_key   TEXT NOT NULL,   -- sabit bir listeden (setupChecklist.js::STEPS), serbest metin değil
  done       BOOLEAN NOT NULL DEFAULT false,
  done_at    TIMESTAMPTZ,
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_setup_checklist_clinic_item
  ON setup_checklist_items (clinic_id, item_key);
