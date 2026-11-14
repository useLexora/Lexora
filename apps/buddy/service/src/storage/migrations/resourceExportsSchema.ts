export const RESOURCE_EXPORTS_SCHEMA_SQL = `
CREATE TABLE remote_exports (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES storage_actors(id),
  data_generation TEXT NOT NULL,
  grant_generation INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES managed_files(id),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  state TEXT NOT NULL CHECK (state IN ('preparing','ready','expired','failed')),
  expires_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX remote_exports_owner ON remote_exports(actor_id, state, expires_ms);
CREATE TRIGGER remote_export_identity BEFORE UPDATE OF id,actor_id,data_generation,grant_generation,source_id,source_version,file_id,name,mime_type,size_bytes,expires_ms ON remote_exports
BEGIN SELECT RAISE(ABORT, 'RESOURCE_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER remote_export_terminal BEFORE UPDATE OF state ON remote_exports
WHEN (OLD.state IN ('expired','failed') AND NEW.state <> OLD.state) OR (OLD.state = 'ready' AND NEW.state = 'preparing')
BEGIN SELECT RAISE(ABORT, 'RESOURCE_STATE_TERMINAL'); END;
`
export const RESOURCE_EXPORT_TABLE_COLUMNS = { remote_exports: ['id', 'actor_id', 'source_id', 'source_version', 'file_id', 'state', 'expires_ms'] }
export const RESOURCE_EXPORT_TRIGGER_NAMES = ['remote_export_identity', 'remote_export_terminal']
export const RESOURCE_EXPORT_INDEX_NAMES = ['remote_exports_owner']
