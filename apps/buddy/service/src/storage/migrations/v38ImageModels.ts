export const BUDDY_V38_IMAGE_MODELS_SCHEMA_SQL = `
CREATE TABLE provider_model_states_next (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  api TEXT NOT NULL,
  input_json TEXT NOT NULL,
  reasoning INTEGER NOT NULL CHECK (reasoning IN (0, 1)),
  cost_json TEXT NOT NULL,
  context_window INTEGER CHECK (context_window > 0),
  max_tokens INTEGER CHECK (max_tokens > 0 AND max_tokens <= context_window),
  override_context_window INTEGER CHECK (override_context_window > 0),
  override_max_tokens INTEGER CHECK (override_max_tokens > 0),
  source_revision TEXT,
  acknowledged_source_revision TEXT,
  source TEXT NOT NULL CHECK (source IN ('builtin', 'manual', 'synced')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  thinking_level_map_json TEXT CHECK (thinking_level_map_json IS NULL OR json_valid(thinking_level_map_json)),
  sampling_params_json TEXT CHECK (sampling_params_json IS NULL OR json_valid(sampling_params_json)),
  compat_json TEXT CHECK (compat_json IS NULL OR json_valid(compat_json)),
  catalog_provider_id TEXT,
  source_fingerprint TEXT NOT NULL DEFAULT '',
  catalog_model_id TEXT,
  catalog_selection_json TEXT CHECK (catalog_selection_json IS NULL OR json_valid(catalog_selection_json)),
  capability_overrides_json TEXT CHECK (capability_overrides_json IS NULL OR json_valid(capability_overrides_json)),
  service_metadata_json TEXT CHECK (service_metadata_json IS NULL OR json_valid(service_metadata_json)),
  model_type TEXT NOT NULL DEFAULT 'chat' CHECK (model_type IN ('chat', 'transcription', 'speech', 'image-generation')),
  type_override TEXT CHECK (type_override IN ('chat', 'transcription', 'speech', 'image-generation')),
  CHECK (COALESCE(type_override, model_type) <> 'chat' OR (context_window IS NOT NULL AND max_tokens IS NOT NULL)),
  PRIMARY KEY (provider_id, model_id)
);

INSERT INTO provider_model_states_next (provider_id, model_id, display_name, api, input_json, reasoning, cost_json, context_window, max_tokens, override_context_window, override_max_tokens, source_revision, acknowledged_source_revision, source, enabled, available, last_seen_at, created_at, updated_at, thinking_level_map_json, sampling_params_json, compat_json, catalog_provider_id, source_fingerprint, catalog_model_id, catalog_selection_json, capability_overrides_json, service_metadata_json, model_type, type_override)
SELECT provider_id, model_id, display_name, api, input_json, reasoning, cost_json, context_window, max_tokens, override_context_window, override_max_tokens, source_revision, acknowledged_source_revision, source, enabled, available, last_seen_at, created_at, updated_at, thinking_level_map_json, sampling_params_json, compat_json, catalog_provider_id, source_fingerprint, catalog_model_id, catalog_selection_json, capability_overrides_json, service_metadata_json, model_type, type_override FROM provider_model_states;

DROP TABLE provider_model_states;
ALTER TABLE provider_model_states_next RENAME TO provider_model_states;

CREATE INDEX idx_provider_model_states_provider
  ON provider_model_states(provider_id, source, display_name, model_id);

CREATE TRIGGER provider_model_override_pair_insert
BEFORE INSERT ON provider_model_states
WHEN
  (NEW.override_context_window IS NULL) <> (NEW.override_max_tokens IS NULL)
  OR NEW.override_max_tokens > NEW.override_context_window
BEGIN
  SELECT RAISE(ABORT, 'provider model parameter override must be a valid pair');
END;

CREATE TRIGGER provider_model_override_pair_update
BEFORE UPDATE OF override_context_window, override_max_tokens ON provider_model_states
WHEN
  (NEW.override_context_window IS NULL) <> (NEW.override_max_tokens IS NULL)
  OR NEW.override_max_tokens > NEW.override_context_window
BEGIN
  SELECT RAISE(ABORT, 'provider model parameter override must be a valid pair');
END;
`
