-- ROI Widget: distinguishes AI-authored replies from human-agent replies
-- (both are role='assistant') so "hours saved by AI" only counts messages
-- the AI actually wrote, not ones a coordinator typed from the panel.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/015_roi.sql

ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_ai boolean;
