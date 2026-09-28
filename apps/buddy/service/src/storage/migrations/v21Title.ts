export const BUDDY_V21_TITLE_SCHEMA_SQL = `
  ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (title_source IN ('manual', 'fallback', 'generated'));
  ALTER TABLE conversations ADD COLUMN title_revision INTEGER NOT NULL DEFAULT 0;
`
