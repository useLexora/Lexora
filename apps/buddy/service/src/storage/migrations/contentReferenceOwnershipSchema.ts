const sources = [
  { table: 'composer_drafts', column: 'content_json', path: '$.resourceQuotes', draft: true },
  { table: 'messages', column: 'content_json', path: '$.userContent.resourceQuotes', draft: false },
  { table: 'chat_queue', column: 'prepared_json', path: '$.userMessageContent.userContent.resourceQuotes', draft: false },
] as const

const exactQuote = `NOT EXISTS (
  SELECT fullkey, type, atom FROM json_tree(reference.quote_json)
  EXCEPT SELECT fullkey, type, atom FROM json_tree(quote.value)
) AND NOT EXISTS (
  SELECT fullkey, type, atom FROM json_tree(quote.value)
  EXCEPT SELECT fullkey, type, atom FROM json_tree(reference.quote_json)
)`

function ownerSelection(source: typeof sources[number], row: string): string {
  return source.draft
    ? `CASE WHEN ${row}.conversation_id IS NULL THEN 'draft' ELSE 'conversation' END, COALESCE(${row}.conversation_id, ${row}.id)`
    : `'conversation', ${row}.conversation_id`
}

function collectExistingSources(referenceId?: string): string {
  return sources.map(source => `
INSERT OR IGNORE INTO product_content_reference_owners (reference_id, owner_kind, owner_id)
SELECT reference.id, ${ownerSelection(source, 'owner')}
FROM ${source.table} owner JOIN json_each(owner.${source.column}, '${source.path}') quote
JOIN product_content_references reference ON json_extract(reference.quote_json, '$.id') = json_extract(quote.value, '$.id')
WHERE ${referenceId ? `reference.id = ${referenceId} AND ` : ''}${exactQuote};
`).join('\n')
}

export const CONTENT_REFERENCE_OWNERSHIP_SCHEMA_SQL = `
CREATE TABLE product_content_reference_owners (
  reference_id TEXT NOT NULL REFERENCES product_content_references(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('conversation', 'draft', 'legacy')),
  owner_id TEXT NOT NULL,
  PRIMARY KEY (reference_id, owner_kind, owner_id)
) STRICT;
CREATE INDEX product_content_reference_owner ON product_content_reference_owners(owner_kind, owner_id);
CREATE INDEX product_content_reference_quote_id ON product_content_references(json_extract(quote_json, '$.id'));

${collectExistingSources()}
INSERT OR IGNORE INTO product_content_reference_owners (reference_id, owner_kind, owner_id)
SELECT reference.id, 'legacy', reference.id FROM product_content_references reference
WHERE NOT EXISTS (SELECT 1 FROM product_content_reference_owners WHERE reference_id = reference.id);

CREATE TRIGGER content_reference_sources_insert AFTER INSERT ON product_content_references
BEGIN
  ${collectExistingSources('NEW.id')}
END;
${sources.flatMap(source => ['insert', 'update'].map(operation => `
CREATE TRIGGER content_reference_${source.table}_${operation} AFTER ${operation === 'insert' ? 'INSERT' : `UPDATE OF ${source.column}, conversation_id`} ON ${source.table}
BEGIN
  INSERT OR IGNORE INTO product_content_reference_owners (reference_id, owner_kind, owner_id)
  SELECT reference.id, ${ownerSelection(source, 'NEW')}
  FROM json_each(NEW.${source.column}, '${source.path}') quote
  JOIN product_content_references reference ON json_extract(reference.quote_json, '$.id') = json_extract(quote.value, '$.id')
  WHERE ${exactQuote};
  ${source.draft
    ? `
  INSERT OR IGNORE INTO product_content_reference_owners (reference_id, owner_kind, owner_id)
  SELECT reference_id, 'conversation', NEW.conversation_id FROM product_content_reference_owners
  WHERE owner_kind = 'draft' AND owner_id = NEW.id AND NEW.conversation_id IS NOT NULL;
  DELETE FROM product_content_reference_owners WHERE owner_kind = 'draft' AND owner_id = NEW.id AND NEW.conversation_id IS NOT NULL;
  `
    : ''}
END;
`)).join('\n')}
CREATE TRIGGER content_reference_owner_immutable BEFORE UPDATE ON product_content_reference_owners
BEGIN SELECT RAISE(ABORT, 'CONTENT_REFERENCE_OWNER_IMMUTABLE'); END;
CREATE TRIGGER content_reference_owner_delete BEFORE DELETE ON product_content_reference_owners
WHEN NOT EXISTS (
  SELECT 1 FROM conversation_deletion_jobs job WHERE job.status = 'pending' AND (
    (OLD.owner_kind = 'conversation' AND OLD.owner_id = job.conversation_id)
    OR (OLD.owner_kind = 'draft' AND OLD.owner_id IN (SELECT value FROM json_each(job.manifest_json, '$.draftIds')))
  )
) AND NOT (
  OLD.owner_kind = 'draft' AND EXISTS (
    SELECT 1 FROM composer_drafts draft JOIN product_content_reference_owners owner
      ON owner.reference_id = OLD.reference_id AND owner.owner_kind = 'conversation' AND owner.owner_id = draft.conversation_id
    WHERE draft.id = OLD.owner_id
  )
)
BEGIN SELECT RAISE(ABORT, 'CONTENT_REFERENCE_OWNER_IMMUTABLE'); END;
`

export const CONTENT_REFERENCE_OWNERSHIP_TRIGGER_NAMES = [
  ...sources.flatMap(source => ['insert', 'update'].map(operation => `content_reference_${source.table}_${operation}`)),
  'content_reference_sources_insert',
  'content_reference_owner_immutable',
  'content_reference_owner_delete',
]
