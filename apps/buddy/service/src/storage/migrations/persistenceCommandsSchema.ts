import { APPROVAL_REVIEWS_SCHEMA_SQL } from './approvalReviewsSchema'
import { CONVERSATION_ARCHIVE_MANAGED_FILES_SCHEMA_SQL } from './conversationArchiveManagedFilesSchema'
import { DRAFT_OWNERSHIP_SCHEMA_SQL } from './draftOwnershipSchema'
import { MANAGED_FILES_SCHEMA_SQL } from './managedFilesSchema'
import { METADATA_COMMANDS_SCHEMA_SQL } from './metadataCommandsSchema'
import { PRODUCT_CONTENT_REFERENCES_SCHEMA_SQL } from './productContentReferencesSchema'

export const PERSISTENCE_COMMANDS_SCHEMA_SQL = `
CREATE TABLE persistence_migrations (
  id TEXT PRIMARY KEY CHECK (id = 'legacy-jsonl-v1'),
  source_fingerprint TEXT NOT NULL,
  source_schema INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('importing', 'verified', 'activated')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE persistence_migration_entries (
  migration_id TEXT NOT NULL REFERENCES persistence_migrations(id),
  kind TEXT NOT NULL CHECK (kind IN ('run', 'file', 'pi', 'draft', 'alias')),
  source_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  PRIMARY KEY (migration_id, kind, source_id)
) STRICT;

CREATE TABLE legacy_request_aliases (
  namespace TEXT NOT NULL,
  request_id TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  source_fingerprint TEXT NOT NULL,
  PRIMARY KEY (namespace, request_id)
) STRICT;

CREATE TRIGGER runs_new_event_sequence AFTER INSERT ON runs
WHEN NEW.next_event_sequence IS NULL AND (SELECT authority FROM storage_profile WHERE id = 1) = 'sqlite'
BEGIN UPDATE runs SET next_event_sequence = 1 WHERE id = NEW.id; END;
ALTER TABLE chat_queue ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE TRIGGER chat_queue_revision AFTER UPDATE OF state, prepared_json, run_id ON chat_queue
WHEN NEW.revision = OLD.revision AND (NEW.state IS NOT OLD.state OR NEW.prepared_json IS NOT OLD.prepared_json OR NEW.run_id IS NOT OLD.run_id)
BEGIN UPDATE chat_queue SET revision = revision + 1 WHERE id = NEW.id; END;
CREATE TABLE chat_queue_deliveries (
  queue_id TEXT PRIMARY KEY REFERENCES chat_queue(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id),
  stage TEXT NOT NULL CHECK (stage IN ('committed', 'submitted', 'unavailable', 'unknown')),
  committed_at TEXT NOT NULL,
  observed_at TEXT
) STRICT;
CREATE TABLE service_admission_gates (
  source_instance_id TEXT PRIMARY KEY NOT NULL,
  stopped_at TEXT NOT NULL,
  command_id TEXT NOT NULL
) STRICT;

${METADATA_COMMANDS_SCHEMA_SQL}
${APPROVAL_REVIEWS_SCHEMA_SQL}
${DRAFT_OWNERSHIP_SCHEMA_SQL}
${MANAGED_FILES_SCHEMA_SQL}
${PRODUCT_CONTENT_REFERENCES_SCHEMA_SQL}
${CONVERSATION_ARCHIVE_MANAGED_FILES_SCHEMA_SQL}
`
