CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  totp_secret_enc text,
  totp_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'web' CHECK (kind IN ('web','worker')),
  repo_full_name text NOT NULL,
  branch text NOT NULL DEFAULT 'main',
  root_directory text NOT NULL DEFAULT '.',
  build_type text NOT NULL DEFAULT 'auto' CHECK (build_type IN ('auto','docker','node','python','static')),
  dockerfile_path text NOT NULL DEFAULT 'Dockerfile',
  build_command text,
  start_command text,
  predeploy_command text,
  internal_port integer NOT NULL DEFAULT 3000,
  health_path text NOT NULL DEFAULT '/healthz',
  cpu_limit numeric NOT NULL DEFAULT 1,
  memory_mb integer NOT NULL DEFAULT 1024,
  auto_deploy boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS variables (
  id text PRIMARY KEY,
  service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  key text NOT NULL,
  value_enc text NOT NULL,
  is_secret boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(service_id, key)
);

CREATE TABLE IF NOT EXISTS domains (
  id text PRIMARY KEY,
  service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  hostname text UNIQUE NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  verification_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);

CREATE TABLE IF NOT EXISTS deployments (
  id text PRIMARY KEY,
  service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  commit_sha text,
  image_ref text,
  source text NOT NULL DEFAULT 'manual',
  rollback_of text REFERENCES deployments(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS deployments_service_created_idx ON deployments(service_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deployment_logs (
  id bigserial PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL
);
CREATE INDEX IF NOT EXISTS deployment_logs_dep_idx ON deployment_logs(deployment_id, id);

CREATE TABLE IF NOT EXISTS servers (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'offline',
  agent_version text,
  cpu_count integer,
  memory_total_mb integer,
  memory_free_mb integer,
  disk_total_mb bigint,
  disk_free_mb bigint,
  load1 numeric,
  container_count integer,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_commands (
  id text PRIMARY KEY,
  server_id text NOT NULL,
  deployment_id text REFERENCES deployments(id) ON DELETE CASCADE,
  action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_commands_poll_idx ON agent_commands(server_id, status, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received'
);

CREATE TABLE IF NOT EXISTS backups (
  id text PRIMARY KEY,
  service_id text REFERENCES services(id) ON DELETE CASCADE,
  server_id text,
  kind text NOT NULL,
  location text,
  status text NOT NULL DEFAULT 'queued',
  size_bytes bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  restore_tested_at timestamptz
);
