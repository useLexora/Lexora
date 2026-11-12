export const EXPERIMENTAL_PERSISTENCE_SCHEMA_SQL = `
CREATE TABLE storage_actors (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('desktop', 'device')),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX storage_actors_desktop ON storage_actors(kind) WHERE kind = 'desktop';

INSERT INTO storage_actors (id, kind, state, created_at)
VALUES ('desktop-local', 'desktop', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE storage_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_generation TEXT NOT NULL CHECK (length(data_generation) > 0),
  local_actor_id TEXT NOT NULL REFERENCES storage_actors(id),
  min_writer_version INTEGER NOT NULL CHECK (min_writer_version > 0),
  authority TEXT NOT NULL CHECK (authority IN ('legacy_jsonl', 'sqlite')),
  migration_state TEXT NOT NULL CHECK (migration_state IN ('pending', 'ready')),
  CHECK ((authority = 'legacy_jsonl' AND migration_state = 'pending')
    OR (authority = 'sqlite' AND migration_state = 'ready'))
) STRICT;

INSERT INTO storage_profile (id, data_generation, local_actor_id, min_writer_version, authority, migration_state)
VALUES (1, lower(hex(randomblob(16))), 'desktop-local', 1, 'legacy_jsonl', 'pending');

CREATE TABLE command_receipts (
  data_generation TEXT NOT NULL CHECK (length(data_generation) > 0),
  actor_id TEXT NOT NULL REFERENCES storage_actors(id),
  command_id TEXT NOT NULL CHECK (length(command_id) > 0),
  method TEXT NOT NULL CHECK (length(method) > 0),
  fingerprint_version INTEGER NOT NULL CHECK (fingerprint_version > 0),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
  source_instance_id TEXT NOT NULL CHECK (length(source_instance_id) > 0),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  target_json TEXT NOT NULL CHECK (json_valid(target_json) AND json_type(target_json) = 'object'),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  error_code TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (data_generation, actor_id, command_id),
  CHECK ((decision = 'accepted' AND error_code IS NULL)
    OR (decision = 'rejected' AND error_code IS NOT NULL AND length(error_code) > 0))
) STRICT;

CREATE TRIGGER command_receipts_no_replace BEFORE INSERT ON command_receipts
WHEN EXISTS (SELECT 1 FROM command_receipts
  WHERE data_generation = NEW.data_generation AND actor_id = NEW.actor_id AND command_id = NEW.command_id)
BEGIN SELECT RAISE(ABORT, 'COMMAND_RECEIPT_ALREADY_DECIDED'); END;

CREATE TRIGGER command_receipts_no_update BEFORE UPDATE ON command_receipts
BEGIN SELECT RAISE(ABORT, 'COMMAND_RECEIPT_IMMUTABLE'); END;

CREATE TRIGGER command_receipts_no_delete BEFORE DELETE ON command_receipts
BEGIN SELECT RAISE(ABORT, 'COMMAND_RECEIPT_IMMUTABLE'); END;

ALTER TABLE runs ADD COLUMN next_event_sequence INTEGER
  CHECK (next_event_sequence IS NULL OR (typeof(next_event_sequence) = 'integer' AND next_event_sequence > 0));
ALTER TABLE run_events ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(format_version) = 'integer' AND format_version > 0);

CREATE TRIGGER runs_event_sequence_monotonic BEFORE UPDATE OF next_event_sequence ON runs
WHEN OLD.next_event_sequence IS NOT NULL
  AND (NEW.next_event_sequence IS NULL OR NEW.next_event_sequence < OLD.next_event_sequence)
BEGIN SELECT RAISE(ABORT, 'RUN_EVENT_SEQUENCE_REGRESSION'); END;
`
