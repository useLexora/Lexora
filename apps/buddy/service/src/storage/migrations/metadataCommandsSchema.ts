export const METADATA_COMMANDS_SCHEMA_SQL = `
ALTER TABLE task_attention ADD COLUMN assignment_revision INTEGER NOT NULL DEFAULT 0 CHECK (assignment_revision >= 0);
CREATE TRIGGER task_attention_assignment_revision AFTER UPDATE OF mark_id ON task_attention
WHEN NEW.assignment_revision = OLD.assignment_revision AND NEW.mark_id IS NOT OLD.mark_id
BEGIN UPDATE task_attention SET assignment_revision = assignment_revision + 1 WHERE conversation_id = NEW.conversation_id; END;
CREATE TRIGGER task_attention_assignment_insert AFTER INSERT ON task_attention WHEN NEW.mark_id IS NOT NULL AND NEW.assignment_revision = 0
BEGIN UPDATE task_attention SET assignment_revision = 1 WHERE conversation_id = NEW.conversation_id; END;
ALTER TABLE task_marks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE TRIGGER task_marks_revision AFTER UPDATE OF name, description, color ON task_marks
WHEN NEW.revision = OLD.revision AND (NEW.name IS NOT OLD.name OR NEW.description IS NOT OLD.description OR NEW.color IS NOT OLD.color)
BEGIN UPDATE task_marks SET revision = revision + 1 WHERE id = NEW.id; END;
`
