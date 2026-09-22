ALTER TABLE volumes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'attached';
ALTER TABLE volumes ADD COLUMN IF NOT EXISTS detached_at timestamptz;
