-- ─────────────────────────────────────────────────────────────────────────
-- Devir SLA Alarmı — Action Center kuyruğunda bekleyen bir devir X dakikada
-- yanıtlanmazsa koordinatöre, hâlâ Y dakika sonra da bekliyorsa yöneticiye
-- hatırlatma gönderir.
--
-- escalated_at, conversations.updated_at'tan BİLEREK ayrı bir sütun: updated_at
-- hasta beklerken tekrar yazsa bile her mesajda değişir (processConversationTurn
-- hâlâ AI ile yanıtlar, sadece 'human_handling' durumunda durur — 'needs_human'
-- değil), bu da updated_at'ı SLA saati olarak kullanırsak saati sürekli
-- sıfırlardı. escalated_at ise SADECE bu bekleme döneminin gerçekten başladığı
-- an sabitlenir (bkz. repository.js saveExchange()'teki COALESCE).
--
-- Çalıştırmak için:
--   psql "$DATABASE_URL" -f db/migrations/023_handover_sla.sql
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS escalated_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_first_reminder_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_escalated_at        TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_needs_human_escalated
  ON conversations (escalated_at) WHERE status = 'needs_human';
