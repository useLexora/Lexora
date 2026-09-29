export const BUDDY_V22_EXTENSION_SCHEMA_SQL = `
CREATE TABLE extension_invocations (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  extension_name TEXT,
  action_title TEXT,
  result_message TEXT,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'skipped', 'failed', 'cancelled', 'interrupted')),
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_extension_invocations_branch ON extension_invocations(conversation_id, branch_id, started_at);
CREATE INDEX idx_extension_invocations_task ON extension_invocations(conversation_id, started_at);
CREATE TABLE usage_records_next (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  invocation_id TEXT REFERENCES extension_invocations(id) ON DELETE CASCADE,
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
  CHECK ((run_id IS NULL) <> (invocation_id IS NULL)),
  UNIQUE (run_id, source_entry_id, purpose),
  UNIQUE (invocation_id, source_entry_id, purpose)
);

INSERT INTO usage_records_next (id, run_id, source_entry_id, provider, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at)
SELECT id, run_id, source_entry_id, provider, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at FROM usage_records;
DROP TABLE usage_records;
ALTER TABLE usage_records_next RENAME TO usage_records;
CREATE INDEX idx_usage_run_created ON usage_records(run_id, created_at);
CREATE INDEX idx_usage_created_at ON usage_records(created_at);
`
