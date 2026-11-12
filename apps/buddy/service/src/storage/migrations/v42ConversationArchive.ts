const usageTriggers = ['insert', 'update', 'delete'].map(operation => `
CREATE TRIGGER invalidate_run_checkpoint_usage_records_${operation} AFTER ${operation.toUpperCase()} ON usage_records
BEGIN DELETE FROM run_event_checkpoints WHERE run_id ${operation === 'update' ? 'IN (OLD.run_id, NEW.run_id)' : `= ${operation === 'delete' ? 'OLD' : 'NEW'}.run_id`}; END;
CREATE TRIGGER dirty_run_events_usage_records_${operation} AFTER ${operation.toUpperCase()} ON usage_records
BEGIN UPDATE run_event_maintenance SET recovery_pending = 1, compaction_pending = 1, revision = revision + 1
WHERE run_id ${operation === 'update' ? 'IN (OLD.run_id, NEW.run_id)' : `= ${operation === 'delete' ? 'OLD' : 'NEW'}.run_id`}; END;
`).join('\n')

export const BUDDY_SCHEMA_LINEAGE = 'archive-v42' as const

export const BUDDY_V42_CONVERSATION_ARCHIVE_SCHEMA_SQL = `
CREATE TABLE buddy_schema_lineage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lineage TEXT NOT NULL CHECK (lineage = '${BUDDY_SCHEMA_LINEAGE}')
) STRICT;
INSERT INTO buddy_schema_lineage VALUES (1, '${BUDDY_SCHEMA_LINEAGE}');
ALTER TABLE conversations ADD COLUMN archived_at TEXT;
ALTER TABLE conversations ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0 CHECK (metadata_revision >= 0);
CREATE INDEX conversations_archived ON conversations(archived_at, id) WHERE archived_at IS NOT NULL;
CREATE TRIGGER runs_require_active_conversation BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'CONVERSATION_NOT_ACTIVE'); END;
CREATE TRIGGER runs_retry_requires_active_conversation BEFORE UPDATE OF status, generation ON runs
WHEN NEW.status IN ('queued', 'running') AND (
  NEW.status IS NOT OLD.status OR (NEW.generation <> OLD.generation AND NOT (
    NEW.generation = OLD.generation + 1
    AND EXISTS (SELECT 1 FROM execution_state WHERE run_id = OLD.id AND phase <> 'closed')
  ))
)
  AND EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'CONVERSATION_NOT_ACTIVE'); END;
CREATE TABLE conversation_archive_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  days INTEGER NOT NULL CHECK (days IN (0, 3, 7, 30))
) STRICT;
INSERT INTO conversation_archive_policy VALUES (1, 0);
CREATE TABLE conversation_deletion_jobs (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
  origin TEXT NOT NULL DEFAULT 'conversation' CHECK (origin IN ('conversation', 'legacy_removed')),
  error_code TEXT,
  manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'pending' AND error_code IS NULL) OR (status = 'failed' AND error_code IS NOT NULL))
) STRICT;
CREATE TRIGGER conversation_members_metadata_insert AFTER INSERT ON conversation_members
BEGIN UPDATE conversations SET metadata_revision = metadata_revision + 1 WHERE id = NEW.conversation_id; END;
CREATE TRIGGER conversation_members_metadata_update AFTER UPDATE OF model_selection_json, model_selection_source, removed_at ON conversation_members
WHEN NEW.model_selection_json IS NOT OLD.model_selection_json OR NEW.model_selection_source IS NOT OLD.model_selection_source OR NEW.removed_at IS NOT OLD.removed_at
BEGIN UPDATE conversations SET metadata_revision = metadata_revision + 1 WHERE id = NEW.conversation_id; END;
CREATE TRIGGER conversation_members_metadata_delete AFTER DELETE ON conversation_members
BEGIN UPDATE conversations SET metadata_revision = metadata_revision + 1 WHERE id = OLD.conversation_id; END;
CREATE TRIGGER conversations_metadata_revision AFTER UPDATE OF active_branch_id, approval_policy, execution_profile, buddy_id, space_id, deleted_at, archived_at ON conversations
WHEN NEW.metadata_revision = OLD.metadata_revision AND (NEW.active_branch_id IS NOT OLD.active_branch_id OR NEW.approval_policy IS NOT OLD.approval_policy OR NEW.execution_profile IS NOT OLD.execution_profile OR NEW.buddy_id IS NOT OLD.buddy_id OR NEW.space_id IS NOT OLD.space_id OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.archived_at IS NOT OLD.archived_at)
BEGIN UPDATE conversations SET metadata_revision = metadata_revision + 1 WHERE id = NEW.id; END;

CREATE TABLE usage_records_next (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  invocation_id TEXT REFERENCES extension_invocations(id) ON DELETE SET NULL,
  source_entry_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER,
  total_tokens INTEGER NOT NULL,
  input_cost REAL NOT NULL,
  output_cost REAL NOT NULL,
  cache_read_cost REAL NOT NULL,
  cache_write_cost REAL NOT NULL,
  total_cost REAL NOT NULL,
  created_at TEXT NOT NULL,
  detached INTEGER NOT NULL DEFAULT 0 CHECK (detached IN (0, 1)),
  CHECK ((detached = 1 AND run_id IS NULL AND invocation_id IS NULL)
    OR (detached = 0 AND ((run_id IS NULL) <> (invocation_id IS NULL)))),
  UNIQUE (run_id, source_entry_id, purpose),
  UNIQUE (invocation_id, source_entry_id, purpose)
);
INSERT INTO usage_records_next SELECT *, 0 FROM usage_records;
DROP TABLE usage_records;
ALTER TABLE usage_records_next RENAME TO usage_records;
CREATE INDEX idx_usage_run_created ON usage_records(run_id, created_at);
CREATE INDEX idx_usage_created_at ON usage_records(created_at);
${usageTriggers}
CREATE TRIGGER detach_usage_before_run_delete BEFORE DELETE ON runs
BEGIN UPDATE usage_records SET detached = 1, run_id = NULL WHERE run_id = OLD.id; END;
CREATE TRIGGER detach_usage_before_invocation_delete BEFORE DELETE ON extension_invocations
BEGIN UPDATE usage_records SET detached = 1, invocation_id = NULL WHERE invocation_id = OLD.id; END;
`

export const BUDDY_ARCHIVE_TRIGGER_NAMES = [...BUDDY_V42_CONVERSATION_ARCHIVE_SCHEMA_SQL.matchAll(/CREATE TRIGGER (\w+)/g)].map(match => match[1]!)
