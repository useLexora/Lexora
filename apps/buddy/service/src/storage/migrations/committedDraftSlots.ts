import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from '../transaction'

export function completeCommittedDraftSlots(database: DatabaseSync): void {
  if (database.prepare('SELECT 1 FROM sqlite_schema WHERE type = \'trigger\' AND name = \'composer_drafts_move_branch_slot\'').get())
    return

  const branchKey = (row: 'NEW' | 'draft') => `json_array('conversation_branch', NULL, ${row}.conversation_id, ${row}.branch_id, NULL, NULL)`
  withTransaction(database, () => {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS composer_drafts_move_branch_slot AFTER UPDATE OF scope_kind, branch_id ON composer_drafts
      WHEN NEW.scope_kind = 'conversation_branch' AND EXISTS (
        SELECT 1 FROM composer_draft_slots WHERE draft_id = NEW.id AND scope_key <> ${branchKey('NEW')}
      )
      BEGIN
        UPDATE composer_draft_slots SET draft_id = NULL, slot_revision = slot_revision + 1 WHERE draft_id = NEW.id;
        INSERT INTO composer_draft_slots (owner_actor_id, scope_key, draft_id, slot_revision)
          VALUES (NEW.owner_actor_id, ${branchKey('NEW')}, NEW.id, 1)
          ON CONFLICT (owner_actor_id, scope_key) DO UPDATE
            SET draft_id = excluded.draft_id, slot_revision = slot_revision + 1 WHERE draft_id IS NULL;
      END;

      UPDATE composer_drafts SET scope_kind = 'conversation_branch' WHERE id IN (
        SELECT draft.id FROM composer_drafts draft JOIN composer_draft_slots slot ON slot.draft_id = draft.id
        WHERE draft.scope_kind = 'conversation_branch' AND slot.scope_key <> ${branchKey('draft')}
      );
    `)
  })
}
