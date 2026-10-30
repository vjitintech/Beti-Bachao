-- Beti Bachao — production schema target (PostgreSQL 15+ with PostGIS 3+).
-- The MVP runs on the JSON store in server/store.js, whose collections mirror
-- these tables one-to-one. Swapping in Postgres means implementing a store
-- adapter; the engine (public/core/engine.js) does not change.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_role AS ENUM ('user', 'volunteer', 'operator', 'admin');
CREATE TYPE incident_status AS ENUM ('CREATED','ALERTING_10KM','ALERTING_20KM','ALERTING_30KM','RESPONDER_ASSIGNED','EN_ROUTE','ARRIVED','ASSISTANCE_IN_PROGRESS','ESCALATION_REQUIRED','NO_RESPONDER_AVAILABLE','EMERGENCY_HANDOFF','USER_CANCELLED','RESPONDER_CANCELLED','LOCATION_UNAVAILABLE','SAFE_CONFIRMED','CLOSED','FALSE_ALARM_REVIEW');
CREATE TYPE escalation_status AS ENUM ('NONE','REQUIRED','SIMULATED','ATTEMPTED','DELIVERED','ACKNOWLEDGED','FAILED');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  email citext UNIQUE NOT NULL,
  role user_role NOT NULL,
  password_hash text,
  mfa_secret_enc bytea,                    -- encrypted with KMS key, never plaintext
  pin_salt text, cancel_pin_hash text, duress_pin_hash text,
  country_code char(2),
  account_status text NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE','SUSPENDED','DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE volunteer_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available boolean NOT NULL DEFAULT false,
  training_completed text[] NOT NULL DEFAULT '{}',
  verification_status text NOT NULL DEFAULT 'NOT_STARTED',
  verification_expires_at timestamptz,
  response_capabilities text[] NOT NULL DEFAULT '{}',
  last_location geography(Point, 4326),
  last_location_accuracy_m integer,
  last_location_at timestamptz,
  no_show_count integer NOT NULL DEFAULT 0,
  suspended_reason text
);
CREATE INDEX volunteer_last_location_gix ON volunteer_profiles USING gist (last_location) WHERE available;

CREATE TABLE verification_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  volunteer_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL, status text NOT NULL,
  reference_token text NOT NULL,          -- provider reference only; no raw ID images
  reviewed_at timestamptz, expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id),
  status incident_status NOT NULL,
  search_stage smallint CHECK (search_stage BETWEEN 0 AND 2),
  stage_deadline timestamptz,             -- durable timer: scheduler polls this column
  severity text NOT NULL CHECK (severity IN ('NORMAL','HIGH')),
  escalation_status escalation_status NOT NULL DEFAULT 'NONE',
  trigger text, silent boolean NOT NULL DEFAULT false, duress boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL,
  country_code char(2) NOT NULL,
  flags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz, safe_confirmation_at timestamptz, closure_reason text,
  UNIQUE (requester_id, idempotency_key)
);
CREATE INDEX incidents_open_deadline_idx ON incidents (stage_deadline) WHERE closed_at IS NULL;
-- At most one open incident per requester.
CREATE UNIQUE INDEX incidents_one_open_per_user ON incidents (requester_id) WHERE status NOT IN ('CLOSED','USER_CANCELLED','FALSE_ALARM_REVIEW','SAFE_CONFIRMED');

CREATE TABLE location_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  point geography(Point, 4326) NOT NULL,
  horizontal_accuracy_m integer NOT NULL CHECK (horizontal_accuracy_m >= 0),
  altitude_m double precision, vertical_accuracy_m double precision,
  user_floor integer, source text NOT NULL,
  suspect boolean NOT NULL DEFAULT false, suspect_reason text,
  observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX location_obs_incident_idx ON location_observations (incident_id, observed_at DESC);

CREATE TABLE responder_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id),
  volunteer_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL, role text NOT NULL,
  accepted_at timestamptz NOT NULL, en_route_at timestamptz, arrived_at timestamptz, assisting_at timestamptz,
  completed_at timestamptz, cancelled_at timestamptz, cancellation_reason text,
  distance_km_at_accept numeric(7,2), eta_min_at_accept integer, stall_flagged boolean NOT NULL DEFAULT false
);
-- A volunteer can hold only one active assignment; race-safe via unique partial index.
CREATE UNIQUE INDEX one_active_assignment_per_volunteer ON responder_assignments (volunteer_id) WHERE status IN ('ACCEPTED','EN_ROUTE','ARRIVED','ASSISTING');

CREATE TABLE responder_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES responder_assignments(id) ON DELETE CASCADE,
  point geography(Point, 4326) NOT NULL, accuracy_m integer, observed_at timestamptz NOT NULL
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id), recipient_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL, channel text NOT NULL, status text NOT NULL, attempt_count integer NOT NULL DEFAULT 0,
  provider_reference text, response text, created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz, responded_at timestamptz
);
CREATE UNIQUE INDEX one_alert_per_volunteer ON notifications (incident_id, recipient_id) WHERE kind = 'ALERT';

CREATE TABLE escalation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id),
  type text NOT NULL, status escalation_status NOT NULL, label text NOT NULL, reason text,
  attempted_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz, recorded_by uuid, metadata jsonb
);

CREATE TABLE safety_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id), actor_id uuid NOT NULL REFERENCES users(id),
  response text NOT NULL CHECK (response IN ('YES','NO','NEED_MORE_HELP')), method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incident_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id),
  from_status incident_status, to_status incident_status NOT NULL,
  actor_id text NOT NULL, reason text, source text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE abuse_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id), incident_id uuid REFERENCES incidents(id),
  category text NOT NULL, details text, status text NOT NULL DEFAULT 'OPEN',
  reviewed_by uuid REFERENCES users(id), resolution text, created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only, hash-chained audit log. No UPDATE/DELETE granted to the app role.
CREATE TABLE audit_events (
  seq bigserial PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  actor_id text NOT NULL, action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  timestamp timestamptz NOT NULL DEFAULT now(), request_id text, reason text, safe_metadata jsonb,
  prev_hash text NOT NULL, hash text NOT NULL
);
CREATE OR REPLACE FUNCTION audit_no_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_no_mutation();

CREATE TABLE country_configs (
  country_code char(2) PRIMARY KEY,
  emergency_number text NOT NULL, verified boolean NOT NULL DEFAULT false,
  radius_stages_km integer[] NOT NULL DEFAULT '{10,20,30}',
  stage_timeouts_sec integer[] NOT NULL DEFAULT '{45,45,60}',
  locale text NOT NULL, escalation_policy jsonb NOT NULL DEFAULT '{}', integration_status text NOT NULL DEFAULT 'SIMULATED'
);

-- Example proximity query used for alerting (equivalent to engine.alertVolunteers):
-- SELECT user_id FROM volunteer_profiles
--  WHERE available AND verification_status = 'VERIFIED' AND suspended_reason IS NULL
--    AND last_location_at > now() - interval '30 minutes'
--    AND ST_DWithin(last_location, $incident_point, $radius_km * 1000);
