ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_port integer;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS detected_build_type text;
