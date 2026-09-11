-- Son modüller (3, 6, 8, 9): cihaz/randevu, post-op görevleri, lojistik.
-- Çalıştır:  psql "$DATABASE_URL" -f db/migrations/005_operations.sql

-- Smart Device Booking (Modül 3)
CREATE TABLE IF NOT EXISTS devices (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  UUID REFERENCES clinics(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT,                     -- 'operating_room' | 'device' | 'chair' ...
  active     BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS appointments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  UUID REFERENCES clinics(id) ON DELETE CASCADE,
  device_id  UUID REFERENCES devices(id) ON DELETE CASCADE,
  lead_id    UUID REFERENCES leads(id) ON DELETE SET NULL,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  status     TEXT NOT NULL DEFAULT 'booked',   -- booked | completed | cancelled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fit-to-Fly & Post-Op + Trust & Review (Modül 8 + 9)
CREATE TABLE IF NOT EXISTS post_op_tasks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  UUID REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id    UUID REFERENCES leads(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,            -- thank_you | review_request | checkin_7 | checkin_30 | fit_to_fly | checkup_1y
  due_at     TIMESTAMPTZ NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | sent
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- VIP Transfer & Logistics (Modül 6)
CREATE TABLE IF NOT EXISTS logistics (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          UUID REFERENCES clinics(id) ON DELETE CASCADE,
  lead_id            UUID REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
  flight_no          TEXT,
  arrival_at         TIMESTAMPTZ,
  transfer_status    TEXT NOT NULL DEFAULT 'pending',    -- pending | arranged | completed
  hotel_status       TEXT NOT NULL DEFAULT 'pending',    -- pending | checked_in | checked_out
  appointment_status TEXT NOT NULL DEFAULT 'pending',    -- pending | scheduled | done
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
