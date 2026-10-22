export const BUDDY_V32_CHANGE_CAPTURE_SCHEMA_SQL = `
ALTER TABLE run_change_sets ADD COLUMN coverage_reasons_json TEXT NOT NULL DEFAULT '[]';
UPDATE run_change_sets SET coverage_reasons_json = '["legacy_partial"]' WHERE coverage = 'partial';
ALTER TABLE run_change_invocations ADD COLUMN capture_mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (capture_mode IN ('legacy', 'files', 'untracked'));
`
