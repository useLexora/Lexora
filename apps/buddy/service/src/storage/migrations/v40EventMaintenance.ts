const projectionTables = [
  ['run_events', 'run_id'],
  ['messages', 'run_id'],
  ['approvals', 'run_id'],
  ['usage_records', 'run_id'],
  ['execution_mailbox_sources', 'source_run_id'],
  ['execution_mailbox_receipts', 'target_run_id'],
] as const

export const BUDDY_EVENT_MAINTENANCE_TRIGGER_NAMES = [
  ...projectionTables.flatMap(([table]) => ['insert', 'update', 'delete'].map(operation => `dirty_run_events_${table}_${operation}`)),
  'dirty_run_events_runs_insert',
  'dirty_run_events_runs_update',
  'dirty_run_events_checkpoint_delete',
  'dirty_run_events_checkpoint_update',
]

export const BUDDY_V40_EVENT_MAINTENANCE_SCHEMA_SQL = `
CREATE TABLE run_event_maintenance (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  recovery_pending INTEGER NOT NULL DEFAULT 1 CHECK (recovery_pending IN (0, 1)),
  compaction_pending INTEGER NOT NULL DEFAULT 1 CHECK (compaction_pending IN (0, 1)),
  projection_version INTEGER NOT NULL DEFAULT 0 CHECK (projection_version >= 0),
  compaction_version INTEGER NOT NULL DEFAULT 0 CHECK (compaction_version >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE INDEX idx_event_recovery_pending ON run_event_maintenance(run_id) WHERE recovery_pending = 1;
CREATE INDEX idx_event_compaction_pending ON run_event_maintenance(run_id) WHERE compaction_pending = 1;
CREATE INDEX idx_event_projection_version ON run_event_maintenance(projection_version, run_id);
CREATE INDEX idx_event_compaction_version ON run_event_maintenance(compaction_version, run_id);
CREATE INDEX idx_event_incomplete_runs ON runs(id) WHERE status IN ('queued', 'running');

INSERT INTO run_event_maintenance (run_id) SELECT id FROM runs;

${projectionTables.map(([table, owner]) => `
CREATE TRIGGER dirty_run_events_${table}_insert AFTER INSERT ON ${table}
BEGIN
  UPDATE run_event_maintenance SET recovery_pending = 1, compaction_pending = 1, revision = revision + 1 WHERE run_id = NEW.${owner};
END;
CREATE TRIGGER dirty_run_events_${table}_update AFTER UPDATE ON ${table}
BEGIN
  UPDATE run_event_maintenance SET recovery_pending = 1, compaction_pending = 1, revision = revision + 1 WHERE run_id IN (OLD.${owner}, NEW.${owner});
END;
CREATE TRIGGER dirty_run_events_${table}_delete AFTER DELETE ON ${table}
BEGIN
  UPDATE run_event_maintenance SET recovery_pending = 1, compaction_pending = 1, revision = revision + 1 WHERE run_id = OLD.${owner};
END;
`).join('\n')}

CREATE TRIGGER dirty_run_events_runs_insert AFTER INSERT ON runs
BEGIN
  INSERT INTO run_event_maintenance (run_id) VALUES (NEW.id);
END;

CREATE TRIGGER dirty_run_events_runs_update
AFTER UPDATE OF status, started_at, completed_at, error_code, conversation_id, branch_id ON runs
BEGIN
  UPDATE run_event_maintenance SET recovery_pending = 1, compaction_pending = 1, revision = revision + 1 WHERE run_id IN (OLD.id, NEW.id);
END;

CREATE TRIGGER dirty_run_events_checkpoint_delete AFTER DELETE ON run_event_checkpoints
BEGIN
  UPDATE run_event_maintenance SET recovery_pending = 1, compaction_pending = 1, revision = revision + 1 WHERE run_id = OLD.run_id;
END;

CREATE TRIGGER dirty_run_events_checkpoint_update AFTER UPDATE ON run_event_checkpoints
BEGIN
  UPDATE run_event_maintenance SET recovery_pending = 1, compaction_pending = 1, revision = revision + 1 WHERE run_id IN (OLD.run_id, NEW.run_id);
END;
`
