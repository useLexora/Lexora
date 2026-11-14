export const REMOTE_FILES_SCHEMA_SQL = `
CREATE TABLE remote_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES storage_actors(id),
  data_generation TEXT NOT NULL,
  grant_generation INTEGER NOT NULL,
  draft_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  file_id TEXT NOT NULL UNIQUE REFERENCES managed_files(id),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('receiving', 'ready', 'adopted', 'cancelled', 'expired', 'failed')),
  confirmed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_bytes >= 0 AND confirmed_bytes <= size_bytes),
  resource_id TEXT NOT NULL UNIQUE,
  attachment_id TEXT NOT NULL UNIQUE,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  input_id TEXT
) STRICT;
CREATE INDEX remote_uploads_owner ON remote_uploads(actor_id, state);
CREATE TABLE remote_upload_chunks (
  upload_id TEXT NOT NULL REFERENCES remote_uploads(id),
  start INTEGER NOT NULL,
  length INTEGER NOT NULL CHECK (length > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (upload_id, start)
) STRICT;
CREATE TRIGGER remote_upload_identity BEFORE UPDATE OF id, actor_id, data_generation, grant_generation, draft_id, expected_revision, file_id, name, mime_type, size_bytes, sha256, resource_id, attachment_id, created_ms, expires_ms ON remote_uploads
BEGIN SELECT RAISE(ABORT, 'UPLOAD_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER remote_upload_terminal BEFORE UPDATE OF state ON remote_uploads
WHEN (OLD.state IN ('adopted', 'cancelled', 'expired', 'failed') AND NEW.state <> OLD.state)
 OR (OLD.state = 'ready' AND NEW.state = 'receiving')
BEGIN SELECT RAISE(ABORT, 'UPLOAD_STATE_TERMINAL'); END;
CREATE TRIGGER remote_upload_prefix BEFORE UPDATE OF confirmed_bytes ON remote_uploads
WHEN NEW.confirmed_bytes < OLD.confirmed_bytes
BEGIN SELECT RAISE(ABORT, 'UPLOAD_PREFIX_REGRESSION'); END;
CREATE TRIGGER remote_upload_chunk_immutable BEFORE UPDATE ON remote_upload_chunks
BEGIN SELECT RAISE(ABORT, 'UPLOAD_CHUNK_IMMUTABLE'); END;
CREATE TRIGGER remote_upload_input_immutable BEFORE UPDATE OF input_id ON remote_uploads
BEGIN SELECT RAISE(ABORT, 'UPLOAD_IDENTITY_IMMUTABLE'); END;
`
export const REMOTE_FILES_TABLE_COLUMNS = { remote_uploads: ['id', 'actor_id', 'data_generation', 'grant_generation', 'file_id', 'state', 'confirmed_bytes', 'sha256', 'input_id'], remote_upload_chunks: ['upload_id', 'start', 'length', 'sha256'] }
export const REMOTE_FILES_TRIGGER_NAMES = ['remote_upload_identity', 'remote_upload_terminal', 'remote_upload_prefix', 'remote_upload_chunk_immutable', 'remote_upload_input_immutable']
export const REMOTE_FILES_INDEX_NAMES = ['remote_uploads_owner']
