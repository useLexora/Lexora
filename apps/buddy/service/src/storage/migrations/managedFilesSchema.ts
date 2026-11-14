export const MANAGED_FILES_SCHEMA_SQL = `
CREATE TABLE managed_files (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL UNIQUE,
  temporary_path TEXT UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'unavailable', 'deleting', 'deleted')),
  durability TEXT CHECK (durability IN ('file-and-directory-sync', 'file-sync', 'legacy-verified')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (state <> 'ready' OR (sha256 IS NOT NULL AND durability IS NOT NULL))
) STRICT;
CREATE TABLE file_preparations (
  id TEXT PRIMARY KEY NOT NULL REFERENCES managed_files(id),
  operation_id TEXT NOT NULL,
  owner_instance TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES storage_actors(id),
  data_generation TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'message', 'copy', 'export')),
  target_owner_id TEXT NOT NULL,
  source_file_id TEXT REFERENCES managed_files(id),
  source_attachment_id TEXT,
  source_draft_id TEXT,
  source_message_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'published', 'settled', 'aborted')),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX file_preparations_sources ON file_preparations(source_file_id, state);
CREATE INDEX file_preparations_active ON file_preparations(state, reserved_bytes) WHERE state IN ('preparing', 'published');
CREATE TABLE file_references (
  file_id TEXT NOT NULL REFERENCES managed_files(id),
  kind TEXT NOT NULL CHECK (kind IN ('draft', 'message', 'queue', 'export')),
  owner_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  PRIMARY KEY (kind, owner_id, binding_id)
) STRICT;
CREATE INDEX file_references_files ON file_references(file_id);
CREATE TRIGGER managed_files_identity_immutable BEFORE UPDATE OF id, path, temporary_path, size_bytes, sha256 ON managed_files
WHEN NEW.id <> OLD.id OR NEW.path <> OLD.path OR NEW.temporary_path IS NOT OLD.temporary_path OR NEW.size_bytes <> OLD.size_bytes
  OR (OLD.sha256 IS NOT NULL AND NEW.sha256 IS NOT OLD.sha256)
BEGIN SELECT RAISE(ABORT, 'FILE_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER managed_files_no_delete BEFORE DELETE ON managed_files
BEGIN SELECT RAISE(ABORT, 'FILE_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER managed_files_claim_unreferenced BEFORE UPDATE OF state ON managed_files
WHEN NEW.state = 'deleting' AND (
  EXISTS (SELECT 1 FROM file_references WHERE file_id = OLD.id)
  OR EXISTS (SELECT 1 FROM file_preparations WHERE state IN ('preparing', 'published') AND (id = OLD.id OR source_file_id = OLD.id))
)
BEGIN SELECT RAISE(ABORT, 'FILE_REFERENCED'); END;
CREATE TRIGGER file_preparations_identity_immutable BEFORE UPDATE OF id, operation_id, owner_instance, actor_id, data_generation, kind, target_owner_id, source_file_id, source_attachment_id, source_draft_id, source_message_id ON file_preparations
BEGIN SELECT RAISE(ABORT, 'FILE_PREPARATION_IMMUTABLE'); END;
CREATE TRIGGER file_preparations_current BEFORE INSERT ON file_preparations
WHEN NOT EXISTS (SELECT 1 FROM storage_profile p JOIN storage_actors a ON a.id = NEW.actor_id
  WHERE p.id = 1 AND p.data_generation = NEW.data_generation AND a.state = 'active')
BEGIN SELECT RAISE(ABORT, 'FILE_PREPARATION_IDENTITY_CHANGED'); END;
CREATE TRIGGER managed_files_no_resurrection BEFORE UPDATE OF state ON managed_files
WHEN (OLD.state = 'deleted' AND NEW.state <> 'deleted')
  OR (OLD.state = 'deleting' AND NEW.state NOT IN ('deleting', 'deleted'))
BEGIN SELECT RAISE(ABORT, 'FILE_DELETION_CLAIMED'); END;
CREATE TRIGGER file_references_ready BEFORE INSERT ON file_references
WHEN EXISTS (SELECT 1 FROM managed_files WHERE id = NEW.file_id AND state IN ('preparing', 'deleting', 'deleted'))
  OR EXISTS (SELECT 1 FROM file_preparations WHERE id = NEW.file_id AND state IN ('preparing', 'aborted'))
  OR ((SELECT authority FROM storage_profile WHERE id = 1) = 'sqlite'
    AND NOT EXISTS (SELECT 1 FROM managed_files WHERE id = NEW.file_id AND state = 'ready'))
BEGIN SELECT RAISE(ABORT, 'FILE_NOT_READY'); END;
CREATE TRIGGER file_references_no_rebind BEFORE UPDATE ON file_references
BEGIN SELECT RAISE(ABORT, 'FILE_REFERENCE_IMMUTABLE'); END;
CREATE TRIGGER file_preparations_source_ready BEFORE INSERT ON file_preparations
WHEN NEW.source_file_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM managed_files WHERE id = NEW.source_file_id AND state = 'ready')
BEGIN SELECT RAISE(ABORT, 'FILE_SOURCE_UNAVAILABLE'); END;
CREATE TRIGGER attachments_file_ready_insert BEFORE INSERT ON attachments
WHEN (SELECT authority FROM storage_profile WHERE id = 1) = 'sqlite'
  AND NOT EXISTS (SELECT 1 FROM managed_files WHERE path = NEW.stored_path AND state = 'ready' AND size_bytes = NEW.size_bytes)
BEGIN SELECT RAISE(ABORT, 'FILE_NOT_READY'); END;
CREATE TRIGGER attachments_file_ready_update BEFORE UPDATE OF stored_path, draft_id, message_id ON attachments
WHEN (SELECT authority FROM storage_profile WHERE id = 1) = 'sqlite'
  AND NOT EXISTS (SELECT 1 FROM managed_files WHERE path = NEW.stored_path AND state = 'ready' AND size_bytes = NEW.size_bytes)
BEGIN SELECT RAISE(ABORT, 'FILE_NOT_READY'); END;
CREATE TRIGGER attachments_source_current_insert BEFORE INSERT ON attachments
WHEN EXISTS (
  SELECT 1 FROM file_preparations p JOIN managed_files f ON f.id = p.id
  WHERE f.path = NEW.stored_path AND p.source_attachment_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM attachments a JOIN managed_files s ON s.path = a.stored_path
      WHERE a.id = p.source_attachment_id AND s.id = p.source_file_id
        AND a.draft_id IS p.source_draft_id AND a.message_id IS p.source_message_id AND s.state = 'ready')
)
BEGIN SELECT RAISE(ABORT, 'FILE_SOURCE_CHANGED'); END;
CREATE TRIGGER attachments_source_current_update BEFORE UPDATE OF stored_path ON attachments
WHEN NEW.stored_path <> OLD.stored_path AND EXISTS (
  SELECT 1 FROM file_preparations p JOIN managed_files f ON f.id = p.id
  WHERE f.path = NEW.stored_path AND p.source_attachment_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM attachments a JOIN managed_files s ON s.path = a.stored_path
      WHERE a.id = p.source_attachment_id AND s.id = p.source_file_id
        AND a.draft_id IS p.source_draft_id AND a.message_id IS p.source_message_id AND s.state = 'ready')
)
BEGIN SELECT RAISE(ABORT, 'FILE_SOURCE_CHANGED'); END;
CREATE TRIGGER attachments_preparation_current_insert BEFORE INSERT ON attachments
WHEN EXISTS (SELECT 1 FROM file_preparations p JOIN managed_files f ON f.id = p.id
  WHERE f.path = NEW.stored_path AND NOT EXISTS (
    SELECT 1 FROM storage_profile s JOIN storage_actors a ON a.id = p.actor_id
    WHERE s.id = 1 AND s.data_generation = p.data_generation AND a.state = 'active'))
BEGIN SELECT RAISE(ABORT, 'FILE_PREPARATION_IDENTITY_CHANGED'); END;
CREATE TRIGGER attachments_preparation_current_update BEFORE UPDATE OF stored_path ON attachments
WHEN NEW.stored_path <> OLD.stored_path AND EXISTS (SELECT 1 FROM file_preparations p JOIN managed_files f ON f.id = p.id
  WHERE f.path = NEW.stored_path AND NOT EXISTS (
    SELECT 1 FROM storage_profile s JOIN storage_actors a ON a.id = p.actor_id
    WHERE s.id = 1 AND s.data_generation = p.data_generation AND a.state = 'active'))
BEGIN SELECT RAISE(ABORT, 'FILE_PREPARATION_IDENTITY_CHANGED'); END;
CREATE TRIGGER attachments_file_reference_insert AFTER INSERT ON attachments
BEGIN
  INSERT INTO file_references (file_id, kind, owner_id, binding_id)
  SELECT id, CASE WHEN NEW.message_id IS NOT NULL THEN 'message'
    WHEN EXISTS (SELECT 1 FROM chat_queue WHERE id = NEW.draft_id) THEN 'queue' ELSE 'draft' END,
    COALESCE(NEW.message_id, NEW.draft_id), NEW.id FROM managed_files WHERE path = NEW.stored_path;
END;
CREATE TRIGGER attachments_file_reference_update AFTER UPDATE OF stored_path, draft_id, message_id ON attachments
BEGIN
  DELETE FROM file_references WHERE binding_id = OLD.id AND kind IN ('draft', 'message', 'queue');
  INSERT INTO file_references (file_id, kind, owner_id, binding_id)
  SELECT id, CASE WHEN NEW.message_id IS NOT NULL THEN 'message'
    WHEN EXISTS (SELECT 1 FROM chat_queue WHERE id = NEW.draft_id) THEN 'queue' ELSE 'draft' END,
    COALESCE(NEW.message_id, NEW.draft_id), NEW.id FROM managed_files WHERE path = NEW.stored_path;
END;
CREATE TRIGGER attachments_file_reference_delete AFTER DELETE ON attachments
BEGIN DELETE FROM file_references WHERE binding_id = OLD.id AND kind IN ('draft', 'message', 'queue'); END;
`

export const MANAGED_FILES_TRIGGER_NAMES = [...MANAGED_FILES_SCHEMA_SQL.matchAll(/CREATE TRIGGER (\w+)/g)].map(match => match[1]!)
export const MANAGED_FILES_INDEX_NAMES = ['file_preparations_sources', 'file_preparations_active', 'file_references_files'] as const
