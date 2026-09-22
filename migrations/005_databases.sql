CREATE TABLE IF NOT EXISTS database_resources (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id text REFERENCES services(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('postgres','redis')),
  name text NOT NULL,
  docker_name text UNIQUE NOT NULL,
  volume_name text UNIQUE NOT NULL,
  server_id text NOT NULL,
  username text,
  password_enc text NOT NULL,
  database_name text,
  variable_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE backups ADD COLUMN IF NOT EXISTS database_id text REFERENCES database_resources(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS database_resources_project_idx ON database_resources(project_id, created_at);
