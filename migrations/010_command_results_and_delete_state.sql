ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS result_enc text;

ALTER TABLE database_resources DROP CONSTRAINT IF EXISTS database_resources_status_check;
