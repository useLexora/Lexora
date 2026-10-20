export const BUDDY_V31_MUTATION_RECOVERY_SCHEMA_SQL = `
CREATE TABLE run_mutation_evidence (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id TEXT NOT NULL REFERENCES run_mutation_leases(invocation_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('constructive', 'quiesced', 'observed', 'waived')),
  outcome TEXT NOT NULL CHECK (outcome IN ('active', 'unknown', 'requested', 'applied')),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('system', 'user')),
  process_id TEXT,
  related_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK ((kind = 'waived' AND actor = 'user') OR (kind <> 'waived' AND actor = 'system'))
);
CREATE INDEX mutation_evidence_invocation ON run_mutation_evidence(invocation_id, sequence);
CREATE UNIQUE INDEX mutation_evidence_blocker ON run_mutation_evidence(invocation_id, related_run_id)
  WHERE related_run_id IS NOT NULL;

CREATE TABLE run_mutation_executions (
  execution_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES run_mutation_leases(invocation_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL,
  launch_state TEXT NOT NULL CHECK (launch_state IN ('prepared', 'authorized', 'settled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX mutation_executions_invocation ON run_mutation_executions(invocation_id);
`
