export const BUDDY_V27_PROVIDER_METADATA_SCHEMA_SQL = `
ALTER TABLE provider_model_states ADD COLUMN service_metadata_json TEXT CHECK (service_metadata_json IS NULL OR json_valid(service_metadata_json));
`
