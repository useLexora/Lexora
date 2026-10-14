export const BUDDY_V29_SESSION_REFERENCES_SCHEMA_SQL = `
CREATE TABLE run_session_reference_scopes (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  public_sequence INTEGER NOT NULL CHECK (public_sequence >= 0),
  graph_json TEXT CHECK (graph_json IS NULL OR json_valid(graph_json))
);
INSERT INTO run_session_reference_scopes (run_id, public_sequence)
SELECT runs.id, CASE WHEN runs.execution_kind = 'root' THEN snapshots.public_sequence ELSE 0 END
FROM runs JOIN run_public_snapshots snapshots ON snapshots.run_id = runs.id;
CREATE TRIGGER freeze_session_reference_scope AFTER INSERT ON runs
BEGIN
  INSERT INTO run_session_reference_scopes (run_id, public_sequence, graph_json)
  VALUES (NEW.id, CASE WHEN NEW.execution_kind = 'root' THEN
    COALESCE((SELECT sequence FROM conversation_public_heads WHERE conversation_id = NEW.conversation_id), 0)
    ELSE COALESCE((SELECT public_sequence FROM run_session_reference_scopes WHERE run_id = NEW.parent_run_id), 0) END,
    (SELECT graph_json FROM run_session_reference_scopes WHERE run_id = NEW.parent_run_id));
END;
CREATE TRIGGER accept_session_reference_input AFTER INSERT ON conversation_publications
WHEN NEW.kind = 'message'
BEGIN
  UPDATE run_session_reference_scopes SET graph_json = NULL, public_sequence = MAX(public_sequence, NEW.sequence)
  WHERE run_id IN (SELECT id FROM runs WHERE triggering_message_id = NEW.message_id AND execution_kind = 'root' AND status = 'queued');
END;
CREATE TRIGGER accept_queued_session_reference_input AFTER UPDATE OF state ON chat_queue
WHEN NEW.state = 'sent' AND OLD.state != 'sent'
BEGIN
  UPDATE run_session_reference_scopes SET graph_json = NULL, public_sequence = MAX(public_sequence,
    COALESCE((SELECT sequence FROM conversation_publications WHERE message_id = json_extract(NEW.prepared_json, '$.userMessageId')), 0))
  WHERE run_id = NEW.run_id;
END;
CREATE TABLE session_reference_exclusions (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, branch_id, session_id)
);
CREATE TRIGGER inherit_session_reference_exclusions AFTER INSERT ON conversation_branches
WHEN NEW.parent_branch_id IS NOT NULL
BEGIN
  INSERT INTO session_reference_exclusions (conversation_id, branch_id, session_id, created_at)
  SELECT NEW.conversation_id, NEW.id, session_id, created_at FROM session_reference_exclusions
  WHERE conversation_id = NEW.conversation_id AND branch_id = NEW.parent_branch_id;
END;
CREATE TRIGGER renew_explicit_session_references AFTER INSERT ON messages
WHEN NEW.role = 'user' AND (NEW.run_id IS NULL OR EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND execution_kind = 'root'))
BEGIN
  DELETE FROM session_reference_exclusions WHERE conversation_id = NEW.conversation_id AND branch_id = NEW.branch_id
  AND session_id IN (SELECT json_extract(value, '$.id') FROM json_each(NEW.content_json, '$.userContent.sessionReferences'));
END;
`
