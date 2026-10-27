-- ─────────────────────────────────────────────────────────────────────────
-- AI Maliyet Panosu — her AI yanıtının Anthropic token kullanımını
-- messages satırının üzerinde tutar (yeni, insan temsilci yanıtlarında
-- NULL kalır — zaten is_ai=false onları ayırıyor). Geriye dönük mesajlar
-- da NULL kalır; toplam maliyet hesaplarken bu satırlar sadece 0 katkı
-- yapar, hata vermez (SUM NULL'ları atlar).
--
-- Çalıştırmak için:
--   psql "$DATABASE_URL" -f db/migrations/025_ai_cost_tracking.sql
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS llm_input_tokens       INTEGER,
  ADD COLUMN IF NOT EXISTS llm_output_tokens      INTEGER,
  ADD COLUMN IF NOT EXISTS llm_cached_read_tokens INTEGER;
