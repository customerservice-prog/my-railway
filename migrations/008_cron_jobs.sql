ALTER TABLE services DROP CONSTRAINT IF EXISTS services_kind_check;
ALTER TABLE services ADD CONSTRAINT services_kind_check CHECK (kind IN ('web','worker','cron'));

ALTER TABLE services ADD COLUMN IF NOT EXISTS cron_expression text;
ALTER TABLE services ADD COLUMN IF NOT EXISTS cron_timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE services ADD COLUMN IF NOT EXISTS cron_command text;
ALTER TABLE services ADD COLUMN IF NOT EXISTS cron_timeout_seconds integer NOT NULL DEFAULT 900;
ALTER TABLE services ADD COLUMN IF NOT EXISTS next_cron_at timestamptz;

CREATE TABLE IF NOT EXISTS cron_runs (
  id text PRIMARY KEY,
  service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  deployment_id text REFERENCES deployments(id) ON DELETE SET NULL,
  server_id text,
  scheduled_for timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'queued',
  exit_code integer,
  logs text,
  command_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cron_runs_service_scheduled_idx
  ON cron_runs(service_id,scheduled_for);
CREATE INDEX IF NOT EXISTS cron_runs_created_idx
  ON cron_runs(created_at DESC);
