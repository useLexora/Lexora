export const BUDDY_V41_USER_QUESTIONS_SCHEMA_SQL = `
CREATE TABLE user_questions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  UNIQUE(run_id, tool_call_id)
);
CREATE INDEX idx_user_questions_run ON user_questions(run_id);
`
