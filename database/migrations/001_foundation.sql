-- 001_foundation: identity, RBAC, geography, trips, segment inventory, bookings, audit.
-- Requires extensions postgis + citext (installed by a superuser/managed-DB console beforehand if the app role cannot).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deletion_requested')),
  suspended_reason text,
  email_verified_at timestamptz,
  locale text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  phone text CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{8,15}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (key text PRIMARY KEY, description text NOT NULL);
CREATE TABLE roles (key text PRIMARY KEY, description text NOT NULL);
CREATE TABLE role_permissions (
  role_key text NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);
CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key text NOT NULL REFERENCES roles(key),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_key)
);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  refresh_token_hash text NOT NULL UNIQUE,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('email_verification','password_reset')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs(target_type, target_id);

CREATE TABLE cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name_ar text NOT NULL,
  name_en text NOT NULL,
  governorate_en text,
  location geography(Point,4326) NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
CREATE INDEX cities_location_gix ON cities USING gist(location);

CREATE TABLE driver_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  verification_status text NOT NULL DEFAULT 'pending_review'
    CHECK (verification_status IN ('not_submitted','pending_review','approved','rejected','expired','requires_resubmission','suspended')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  make text NOT NULL CHECK (char_length(make) BETWEEN 1 AND 60),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 60),
  color text NOT NULL CHECK (char_length(color) BETWEEN 1 AND 30),
  -- total seats including the driver; bookable seats are at most seats - 1
  seats smallint NOT NULL CHECK (seats BETWEEN 2 AND 8),
  plate_number text NOT NULL CHECK (char_length(plate_number) BETWEEN 3 AND 20),
  verification_status text NOT NULL DEFAULT 'pending_review'
    CHECK (verification_status IN ('pending_review','approved','rejected','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, plate_number)
);

CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES users(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  departure_at timestamptz NOT NULL,
  arrival_at timestamptz NOT NULL,
  seats_total smallint NOT NULL CHECK (seats_total BETWEEN 1 AND 7),
  booking_mode text NOT NULL DEFAULT 'approval' CHECK (booking_mode IN ('instant','approval')),
  currency char(3) NOT NULL DEFAULT 'EGP',
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (arrival_at > departure_at)
);
CREATE INDEX trips_status_departure_idx ON trips(status, departure_at);
CREATE INDEX trips_driver_idx ON trips(driver_id, departure_at);

CREATE TABLE trip_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seq smallint NOT NULL CHECK (seq >= 0),
  city_id uuid NOT NULL REFERENCES cities(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  location geography(Point,4326) NOT NULL,
  offset_minutes integer NOT NULL CHECK (offset_minutes >= 0),
  UNIQUE (trip_id, seq)
);
CREATE INDEX trip_stops_location_gix ON trip_stops USING gist(location);
CREATE INDEX trip_stops_city_idx ON trip_stops(city_id, trip_id);

-- Segment i joins stop seq i to stop seq i+1. This is the seat-inventory unit.
-- The CHECK constraint is the last line of defence: no code path can overbook a segment.
CREATE TABLE trip_segments (
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seq smallint NOT NULL CHECK (seq >= 0),
  from_stop_id uuid NOT NULL REFERENCES trip_stops(id),
  to_stop_id uuid NOT NULL REFERENCES trip_stops(id),
  price_minor integer NOT NULL CHECK (price_minor > 0),
  seats_total smallint NOT NULL CHECK (seats_total BETWEEN 1 AND 7),
  seats_booked smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, seq),
  CONSTRAINT segment_not_overbooked CHECK (seats_booked >= 0 AND seats_booked <= seats_total)
);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  passenger_id uuid NOT NULL REFERENCES users(id),
  from_stop_seq smallint NOT NULL,
  to_stop_seq smallint NOT NULL,
  seats smallint NOT NULL CHECK (seats BETWEEN 1 AND 7),
  status text NOT NULL CHECK (status IN
    ('pending_approval','awaiting_payment','confirmed','rejected','cancelled','expired','completed','no_show')),
  price_total_minor integer NOT NULL CHECK (price_total_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'EGP',
  expires_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_stop_seq > from_stop_seq)
);
-- A passenger can hold at most one active (seat-holding) booking per trip.
CREATE UNIQUE INDEX bookings_one_active_per_passenger
  ON bookings(trip_id, passenger_id) WHERE status IN ('pending_approval','awaiting_payment','confirmed');
CREATE INDEX bookings_passenger_idx ON bookings(passenger_id, created_at DESC);
CREATE INDEX bookings_trip_idx ON bookings(trip_id);
CREATE INDEX bookings_expiry_idx ON bookings(expires_at) WHERE status IN ('pending_approval','awaiting_payment');

CREATE TABLE booking_status_history (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_status_history_booking_idx ON booking_status_history(booking_id);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, key)
);
