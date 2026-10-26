-- ─────────────────────────────────────────────────────────────────────────
-- Haftalık Sonuç Raporu — her Pazartesi klinik sahibine otomatik özet.
-- Atomik claim için tek sütun: aynı haftada iki kez gönderilmesini (yerel
-- setInterval + Vercel Cron'un aynı anda çalışması, ya da bir tick'in
-- gecikmesi) engeller — bkz. repository.js claimWeeklyReportSlot().
--
-- Çalıştırmak için:
--   psql "$DATABASE_URL" -f db/migrations/023_weekly_report.sql
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS last_weekly_report_sent_at TIMESTAMPTZ;
