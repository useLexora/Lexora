export const APPROVAL_REVIEWS_SCHEMA_SQL = `
CREATE TABLE approval_reviews (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
  review_json TEXT NOT NULL CHECK (json_valid(review_json) AND json_type(review_json) = 'object')
) STRICT;
CREATE TRIGGER approval_reviews_immutable BEFORE UPDATE ON approval_reviews
BEGIN SELECT RAISE(ABORT, 'APPROVAL_REVIEW_IMMUTABLE'); END;
CREATE TABLE approval_decisions (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
  resolution TEXT,
  actor_id TEXT REFERENCES storage_actors(id),
  cancellation_reason TEXT CHECK (cancellation_reason IN ('cancelled', 'expired', 'recovery', 'shutdown')),
  decided_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE ON approval_decisions
BEGIN SELECT RAISE(ABORT, 'APPROVAL_DECISION_IMMUTABLE'); END;
`
