ALTER TABLE services ADD COLUMN IF NOT EXISTS maintenance_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE services ADD COLUMN IF NOT EXISTS maintenance_message text NOT NULL DEFAULT 'We are performing scheduled maintenance. Please try again shortly.';
