ALTER TABLE services ALTER COLUMN health_path SET DEFAULT '/';
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS server_id text;
CREATE INDEX IF NOT EXISTS deployments_server_idx ON deployments(server_id);

CREATE TABLE IF NOT EXISTS volumes (
  id text PRIMARY KEY,
  service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name text NOT NULL,
  docker_volume_name text UNIQUE NOT NULL,
  mount_path text NOT NULL,
  read_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(service_id, mount_path)
);

ALTER TABLE backups ADD COLUMN IF NOT EXISTS volume_id text REFERENCES volumes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS backups_service_created_idx ON backups(service_id, created_at DESC);
