UPDATE "ChatSessionMessagePart"
SET "metadata" = jsonb_set("metadata", '{toolKind}', '"skill"'::jsonb, false)
WHERE "metadata" IS NOT NULL
  AND jsonb_typeof("metadata") = 'object'
  AND "metadata"->>'toolKind' IN ('memory', 'web');
