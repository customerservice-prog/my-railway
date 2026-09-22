ALTER TABLE servers ADD COLUMN IF NOT EXISTS draining boolean NOT NULL DEFAULT false;

ALTER TABLE database_resources ADD COLUMN IF NOT EXISTS last_health_at timestamptz;
ALTER TABLE database_resources ADD COLUMN IF NOT EXISTS health_message text;
ALTER TABLE database_resources ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS servers_schedulable_idx ON servers(draining,last_seen_at);
