-- Hastanın WhatsApp'tan attığı fotoğrafları (saç ekimi/estetik triyajının
-- kalbi) saklamak için. Küçük hacimli, düşük trafikli bir MVP'de bytea
-- yeterli — S3/blob storage'a geçiş sonra, ihtiyaç çıkarsa.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/014_message_media.sql

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_data      bytea,
  ADD COLUMN IF NOT EXISTS media_mime_type text;
