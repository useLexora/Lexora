import { CONTENT_REFERENCE_OWNERSHIP_SCHEMA_SQL } from './contentReferenceOwnershipSchema'

export const CONVERSATION_ARCHIVE_MANAGED_FILES_SCHEMA_SQL = `
DROP TRIGGER managed_files_no_delete;
CREATE TRIGGER managed_files_no_delete BEFORE DELETE ON managed_files
WHEN OLD.state <> 'deleted' OR NOT EXISTS (
  SELECT 1 FROM conversation_deletion_jobs j, json_each(j.manifest_json, '$.fileIds') f
  WHERE j.status = 'pending' AND f.value = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'FILE_IDENTITY_IMMUTABLE'); END;
${CONTENT_REFERENCE_OWNERSHIP_SCHEMA_SQL}
DROP TRIGGER product_content_references_no_delete;
CREATE TRIGGER product_content_references_no_delete BEFORE DELETE ON product_content_references
WHEN EXISTS (SELECT 1 FROM product_content_reference_owners WHERE reference_id = OLD.id) OR NOT EXISTS (
  SELECT 1 FROM conversation_deletion_jobs j, json_each(j.manifest_json, '$.contentReferenceIds') r
  WHERE j.status = 'pending' AND r.value = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'CONTENT_REFERENCE_IMMUTABLE'); END;
`
