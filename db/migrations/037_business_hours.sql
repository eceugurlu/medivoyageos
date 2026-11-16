-- Mesai Saatleri — klinik başına ayarlanabilir tek sabit (src/services/businessHours.js).
-- NULL = varsayılan (Pazartesi–Cumartesi 09:00–19:00, Europe/Istanbul, Pazar kapalı).
-- Şekil: { timezone, openHour, closeHour, closedWeekdays: [0..6, Pzt=0] }.
ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS business_hours JSONB;
