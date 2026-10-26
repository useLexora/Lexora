export const BUDDY_V33_EXECUTION_WORK_SCHEMA_SQL = `
ALTER TABLE runs ADD COLUMN scheduling_lane TEXT NOT NULL DEFAULT 'conversation' CHECK (scheduling_lane IN ('conversation', 'actor'));
CREATE INDEX execution_scheduling_lane ON runs(conversation_id, scheduling_lane, buddy_id, status);
DROP INDEX execution_actor_thread;
CREATE INDEX execution_actor_threads ON execution_threads(conversation_id, actor_id, kind);
CREATE TABLE execution_work_attempts (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  previous_run_id TEXT REFERENCES runs(id),
  context_mode TEXT NOT NULL DEFAULT 'conversation' CHECK (context_mode IN ('isolated', 'conversation')),
  context_source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(context_source_ids_json)),
  brief_json TEXT CHECK (brief_json IS NULL OR json_valid(brief_json)),
  submission_json TEXT CHECK (submission_json IS NULL OR json_valid(submission_json)),
  review_json TEXT CHECK (review_json IS NULL OR json_valid(review_json))
);
CREATE INDEX execution_work_history ON execution_work_attempts(work_id, run_id);
CREATE UNIQUE INDEX execution_work_successor ON execution_work_attempts(previous_run_id) WHERE previous_run_id IS NOT NULL;
INSERT INTO execution_work_attempts (run_id, work_id, context_mode)
  SELECT id, id, CASE WHEN execution_kind = 'npc_child' THEN 'isolated' ELSE 'conversation' END FROM runs;
CREATE TRIGGER initialize_execution_work AFTER INSERT ON runs
BEGIN
  INSERT INTO execution_work_attempts (run_id, work_id, context_mode)
    VALUES (NEW.id, NEW.id, CASE WHEN NEW.execution_kind = 'npc_child' THEN 'isolated' ELSE 'conversation' END);
END;
`
