export const DRAFT_OWNERSHIP_SCHEMA_SQL = `
ALTER TABLE composer_drafts ADD COLUMN owner_actor_id TEXT REFERENCES storage_actors(id);
UPDATE composer_drafts SET owner_actor_id = (SELECT local_actor_id FROM storage_profile WHERE id = 1);
DROP INDEX composer_drafts_global_scope;
DROP INDEX composer_drafts_space_scope;
DROP INDEX composer_drafts_branch_scope;
DROP INDEX composer_drafts_message_edit_scope;
DROP INDEX composer_drafts_followup_scope;
CREATE INDEX composer_drafts_owner ON composer_drafts(owner_actor_id, updated_at DESC);

CREATE TABLE composer_draft_slots (
  owner_actor_id TEXT NOT NULL REFERENCES storage_actors(id),
  scope_key TEXT NOT NULL CHECK (json_valid(scope_key) AND json_type(scope_key) = 'array'),
  draft_id TEXT UNIQUE REFERENCES composer_drafts(id) ON DELETE SET NULL,
  slot_revision INTEGER NOT NULL DEFAULT 0 CHECK (slot_revision >= 0),
  PRIMARY KEY (owner_actor_id, scope_key)
) STRICT;

INSERT INTO composer_draft_slots (owner_actor_id, scope_key, draft_id, slot_revision)
SELECT owner_actor_id,
  json_array(scope_kind, CASE WHEN scope_kind = 'space' THEN space_id END,
    conversation_id, branch_id, source_message_id, CASE WHEN scope_kind = 'task' THEN id END),
  id, 0 FROM composer_drafts;

CREATE TRIGGER composer_drafts_default_owner AFTER INSERT ON composer_drafts
WHEN NEW.owner_actor_id IS NULL
BEGIN UPDATE composer_drafts SET owner_actor_id = (SELECT local_actor_id FROM storage_profile WHERE id = 1) WHERE id = NEW.id; END;
CREATE TRIGGER composer_drafts_owner_immutable BEFORE UPDATE OF owner_actor_id ON composer_drafts
WHEN OLD.owner_actor_id IS NOT NULL AND NEW.owner_actor_id IS NOT OLD.owner_actor_id
BEGIN SELECT RAISE(ABORT, 'DRAFT_OWNER_IMMUTABLE'); END;
CREATE TRIGGER composer_drafts_release_slot BEFORE DELETE ON composer_drafts
BEGIN UPDATE composer_draft_slots SET draft_id = NULL, slot_revision = slot_revision + 1 WHERE draft_id = OLD.id; END;
CREATE TRIGGER composer_draft_slots_owner_insert BEFORE INSERT ON composer_draft_slots
WHEN NEW.draft_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM composer_drafts WHERE id = NEW.draft_id AND owner_actor_id = NEW.owner_actor_id)
BEGIN SELECT RAISE(ABORT, 'DRAFT_OWNER_MISMATCH'); END;
CREATE TRIGGER composer_draft_slots_owner_update BEFORE UPDATE OF owner_actor_id, draft_id ON composer_draft_slots
WHEN NEW.owner_actor_id <> OLD.owner_actor_id OR (NEW.draft_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM composer_drafts WHERE id = NEW.draft_id AND owner_actor_id = NEW.owner_actor_id))
BEGIN SELECT RAISE(ABORT, 'DRAFT_OWNER_MISMATCH'); END;
CREATE TRIGGER composer_draft_slots_revision BEFORE UPDATE ON composer_draft_slots
WHEN NEW.scope_key <> OLD.scope_key OR NEW.slot_revision < OLD.slot_revision
  OR (NEW.draft_id IS NOT OLD.draft_id AND NEW.slot_revision <> OLD.slot_revision + 1)
BEGIN SELECT RAISE(ABORT, 'DRAFT_SLOT_REVISION_CONFLICT'); END;
`
