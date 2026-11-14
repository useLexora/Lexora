export const BRANCH_EXECUTION_SCHEMA_SQL = `
DROP TRIGGER initialize_execution;
CREATE TRIGGER initialize_execution AFTER INSERT ON runs
BEGIN
  INSERT OR IGNORE INTO execution_threads (id, conversation_id, actor_id, kind, created_at)
    SELECT 'actor:' || json_array(NEW.conversation_id, NEW.buddy_id, NEW.branch_id), NEW.conversation_id, NEW.buddy_id, 'actor', NEW.started_at
    WHERE NEW.thread_id IS NULL;
  UPDATE runs SET root_run_id = COALESCE(NEW.root_run_id, NEW.id),
    thread_id = COALESCE(NEW.thread_id, 'actor:' || json_array(NEW.conversation_id, NEW.buddy_id, NEW.branch_id)),
    execution_kind = CASE WHEN NEW.purpose = 'conversation.compaction' AND NEW.execution_kind = 'root' THEN 'maintenance' ELSE NEW.execution_kind END
    WHERE id = NEW.id;
  INSERT INTO execution_state (run_id, phase) VALUES (NEW.id,
    CASE NEW.status WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'working' ELSE 'closed' END);
END;
`
