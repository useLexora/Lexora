export const BUDDY_V23_PROVIDERS_SCHEMA_SQL = `
UPDATE builtin_provider_configs
SET builtin_provider_id = 'azure'
WHERE builtin_provider_id = 'azure-openai-responses';
`
