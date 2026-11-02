export const BUDDY_PROVIDER_RESOLUTION_TRIGGER_NAMES = [
  'provider_resolution_invalidate_insert',
  'provider_resolution_invalidate_update',
  'provider_resolution_invalidate_delete',
] as const

export const BUDDY_V39_PROVIDER_RESOLUTION_SCHEMA_SQL = `
ALTER TABLE provider_model_states ADD COLUMN resolution_json TEXT
  CHECK (resolution_json IS NULL OR json_valid(resolution_json));

CREATE TABLE provider_resolution_checkpoints (
  provider_id TEXT PRIMARY KEY,
  input_fingerprint TEXT NOT NULL
);

CREATE TRIGGER provider_resolution_invalidate_insert AFTER INSERT ON provider_model_states BEGIN
  DELETE FROM provider_resolution_checkpoints WHERE provider_id = NEW.provider_id;
END;
CREATE TRIGGER provider_resolution_invalidate_update AFTER UPDATE ON provider_model_states
WHEN OLD.provider_id IS NOT NEW.provider_id OR OLD.model_id IS NOT NEW.model_id
  OR OLD.api IS NOT NEW.api OR OLD.source IS NOT NEW.source
  OR OLD.model_type IS NOT NEW.model_type OR OLD.type_override IS NOT NEW.type_override
  OR OLD.catalog_provider_id IS NOT NEW.catalog_provider_id OR OLD.catalog_model_id IS NOT NEW.catalog_model_id
  OR OLD.catalog_selection_json IS NOT NEW.catalog_selection_json
  OR OLD.service_metadata_json IS NOT NEW.service_metadata_json
  OR OLD.resolution_json IS NOT NEW.resolution_json
BEGIN
  DELETE FROM provider_resolution_checkpoints WHERE provider_id IN (OLD.provider_id, NEW.provider_id);
END;
CREATE TRIGGER provider_resolution_invalidate_delete AFTER DELETE ON provider_model_states BEGIN
  DELETE FROM provider_resolution_checkpoints WHERE provider_id = OLD.provider_id;
END;
`
