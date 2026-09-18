export const BUDDY_V20_TASK_DRAFTS_SCHEMA_SQL = `
CREATE TABLE composer_drafts_next (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('task', 'global', 'space', 'conversation_branch', 'message_edit', 'message_followup')),
  space_id TEXT REFERENCES spaces(id),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE,
  source_message_id TEXT REFERENCES messages(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  model_selection_json TEXT CHECK (model_selection_json IS NULL OR json_valid(model_selection_json)),
  approval_policy TEXT NOT NULL CHECK (approval_policy IN ('manual', 'policy')),
  execution_profile TEXT NOT NULL CHECK (execution_profile IN ('read_only', 'workspace_write', 'full_access')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope_kind = 'task' AND conversation_id IS NULL AND branch_id IS NULL AND source_message_id IS NULL)
    OR (scope_kind = 'global' AND space_id IS NULL AND conversation_id IS NULL AND branch_id IS NULL AND source_message_id IS NULL)
    OR (scope_kind = 'space' AND space_id IS NOT NULL AND conversation_id IS NULL AND branch_id IS NULL AND source_message_id IS NULL)
    OR (scope_kind = 'conversation_branch' AND space_id IS NULL AND conversation_id IS NOT NULL AND branch_id IS NOT NULL AND source_message_id IS NULL)
    OR (scope_kind IN ('message_edit', 'message_followup') AND space_id IS NULL AND conversation_id IS NOT NULL AND branch_id IS NOT NULL AND source_message_id IS NOT NULL)
  )
);
INSERT INTO composer_drafts_next SELECT * FROM composer_drafts;
UPDATE composer_drafts_next SET scope_kind = 'task' WHERE scope_kind IN ('global', 'space');
DROP TABLE composer_drafts;
ALTER TABLE composer_drafts_next RENAME TO composer_drafts;
CREATE UNIQUE INDEX composer_drafts_global_scope ON composer_drafts(scope_kind) WHERE scope_kind = 'global';
CREATE UNIQUE INDEX composer_drafts_space_scope ON composer_drafts(space_id) WHERE scope_kind = 'space';
CREATE UNIQUE INDEX composer_drafts_branch_scope ON composer_drafts(conversation_id, branch_id) WHERE scope_kind = 'conversation_branch';
CREATE UNIQUE INDEX composer_drafts_message_edit_scope ON composer_drafts(conversation_id, branch_id, source_message_id) WHERE scope_kind = 'message_edit';

CREATE UNIQUE INDEX composer_drafts_followup_scope ON composer_drafts(conversation_id, branch_id, source_message_id) WHERE scope_kind = 'message_followup';

`
