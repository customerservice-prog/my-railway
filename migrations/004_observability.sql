CREATE TABLE IF NOT EXISTS service_health (
  service_id text PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  deployment_id text REFERENCES deployments(id) ON DELETE SET NULL,
  healthy boolean NOT NULL DEFAULT false,
  status_code integer,
  latency_ms integer,
  message text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id text PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  type text NOT NULL,
  fingerprint text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  target_type text,
  target_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_fingerprint_idx
  ON alerts(fingerprint) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS alerts_created_idx ON alerts(created_at DESC);
