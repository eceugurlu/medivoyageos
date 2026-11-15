-- Tasarım Ortağı KPI Paneli.
--
-- Pilot kliniğin ("tasarım ortağı") kendisiyle yaptığımız anlaşmayı somut
-- sayılara döker: başlangıç değeri (baseline), hedef (target), ve o anki
-- gerçek ölçüm. Ölçüm burada SAKLANMAZ — her zaman anlık hesaplanır (bkz.
-- services/designPartnerKpis.js), tıpkı no-show risk skoru gibi; saklanan
-- tek şey kliniğin kabul ettiği hedeftir.
--
-- Metrik kimlikleri sabit bir listeden gelir (response_time_seconds,
-- appointment_conversion_rate); serbest metin değil, çünkü ölçüm
-- fonksiyonu her metrik için ayrı bir SQL sorgusu çalıştırıyor ve
-- tanımadığı bir metrik adını sessizce yanlış yorumlayabilir.

CREATE TABLE IF NOT EXISTS design_partner_goals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  metric        TEXT NOT NULL CHECK (metric IN ('response_time_seconds', 'appointment_conversion_rate')),
  baseline_value NUMERIC,
  target_value   NUMERIC,
  baseline_date  DATE,
  note           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_design_partner_goals_clinic_metric
  ON design_partner_goals (clinic_id, metric);
