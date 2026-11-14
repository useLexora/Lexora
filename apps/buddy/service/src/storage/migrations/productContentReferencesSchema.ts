export const PRODUCT_CONTENT_REFERENCES_SCHEMA_SQL = `
CREATE TABLE product_content_references (
  id TEXT PRIMARY KEY NOT NULL,
  owner_actor_id TEXT NOT NULL REFERENCES storage_actors(id),
  data_generation TEXT NOT NULL,
  quote_json TEXT NOT NULL CHECK (json_valid(quote_json) AND json_type(quote_json) = 'object'),
  created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER product_content_references_no_replace BEFORE INSERT ON product_content_references
WHEN EXISTS (SELECT 1 FROM product_content_references WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'CONTENT_REFERENCE_IMMUTABLE'); END;
CREATE TRIGGER product_content_references_no_update BEFORE UPDATE ON product_content_references
BEGIN SELECT RAISE(ABORT, 'CONTENT_REFERENCE_IMMUTABLE'); END;
CREATE TRIGGER product_content_references_no_delete BEFORE DELETE ON product_content_references
BEGIN SELECT RAISE(ABORT, 'CONTENT_REFERENCE_IMMUTABLE'); END;
CREATE TRIGGER product_content_references_identity BEFORE INSERT ON product_content_references
WHEN NOT EXISTS (SELECT 1 FROM storage_actors WHERE id = NEW.owner_actor_id AND state = 'active')
  OR NOT EXISTS (SELECT 1 FROM storage_profile WHERE id = 1 AND data_generation = NEW.data_generation AND authority = 'sqlite' AND migration_state = 'ready')
BEGIN SELECT RAISE(ABORT, 'CONTENT_REFERENCE_OWNER_UNAVAILABLE'); END;
`
export const PRODUCT_CONTENT_REFERENCES_TRIGGER_NAMES = [
  'product_content_references_no_replace',
  'product_content_references_no_update',
  'product_content_references_no_delete',
  'product_content_references_identity',
] as const
