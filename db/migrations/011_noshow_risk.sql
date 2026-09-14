-- No-show/iptal risk skorunun bildirim durumu. Skor eşiği geçince koordinatöre
-- bir kez bildirim gider; bu sütun o bildirimin ne zaman atıldığını tutar ki
-- her dakikalık tarama aynı lead için tekrar tekrar bildirim atmasın. Skor
-- eşiğin altına düşerse temizlenir, böylece yeniden eşiği geçerse tekrar
-- bildirim gidebilir (bkz. repository.js getNoShowRisks / markRiskNotified).
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/011_noshow_risk.sql

ALTER TABLE leads ADD COLUMN IF NOT EXISTS risk_notified_at timestamptz;
