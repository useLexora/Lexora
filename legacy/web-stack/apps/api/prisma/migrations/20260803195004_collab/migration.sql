BEGIN;

DELETE FROM "NotificationReadReceipt"
WHERE "sourceKind" = 'DOCUMENT_COLLABORATION_USER_INVITE';

CREATE TYPE "NotificationSourceKind_new" AS ENUM ('PLATFORM');

ALTER TABLE "NotificationReadReceipt"
ALTER COLUMN "sourceKind" TYPE "NotificationSourceKind_new"
USING ("sourceKind"::text::"NotificationSourceKind_new");

DROP TYPE "NotificationSourceKind";
ALTER TYPE "NotificationSourceKind_new" RENAME TO "NotificationSourceKind";

DELETE FROM "RolePermission"
WHERE "permissionId" IN (
  SELECT "id"
  FROM "Permission"
  WHERE "code" = 'user:lookup_by_code'
);

DELETE FROM "Permission"
WHERE "code" = 'user:lookup_by_code';

LOCK TABLE
  "DocumentYdoc",
  "DocumentYdocUpdate",
  "DocumentCurrentProjection"
IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  unmaterialized_document_ids TEXT;
BEGIN
  SELECT string_agg(unsafe."documentId", ', ' ORDER BY unsafe."documentId")
  INTO unmaterialized_document_ids
  FROM (
    SELECT ydoc."documentId"
    FROM "DocumentYdoc" AS ydoc
    LEFT JOIN "DocumentCurrentProjection" AS projection
      ON projection."id" = ydoc."lastProjectedProjectionId"
    WHERE ydoc."updateSeq" > 0
      AND (
        ydoc."checkpointState" IS NULL
        OR ydoc."checkpointUpdateSeq" <> ydoc."updateSeq"
        OR projection."id" IS NULL
        OR projection."documentId" <> ydoc."documentId"
        OR projection."runtimeEpoch" <> ydoc."runtimeEpoch"
        OR projection."projectedUpdateSeq" <> ydoc."updateSeq"
        OR projection."checkpointSeq" <> ydoc."checkpointSeq"
        OR projection."checkpointUpdateSeq" <> ydoc."updateSeq"
        OR projection."projectionRevision" <> ydoc."lastProjectedProjectionRevision"
      )
    ORDER BY ydoc."documentId"
    LIMIT 20
  ) AS unsafe;

  IF unmaterialized_document_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot remove collaboration tables: unmaterialized DocumentYdoc updates exist. Stop the old application stack gracefully and retry the migration.'
      USING DETAIL = format('Affected documents (up to 20): %s', unmaterialized_document_ids);
  END IF;
END $$;

DROP TABLE "DocumentCollabTicket";
DROP TABLE "CollaborationResolverEntry";
DROP TABLE "DocumentCollaborationUserInvite";
DROP TABLE "DocumentCollaborationLinkInvite";
DROP TABLE "DocumentCollaborationGrant";
DROP TABLE "DocumentYdocUpdate";
DROP TABLE "DocumentYdoc";

ALTER TABLE "DocumentCurrentProjection"
ADD COLUMN "idempotencyKey" TEXT,
DROP COLUMN "runtimeEpoch",
DROP COLUMN "projectedUpdateSeq",
DROP COLUMN "checkpointSeq",
DROP COLUMN "checkpointUpdateSeq";

ALTER TABLE "DocumentVersionSnapshot"
DROP COLUMN "runtimeEpoch",
DROP COLUMN "projectedUpdateSeq",
DROP COLUMN "checkpointSeq",
DROP COLUMN "checkpointUpdateSeq";

CREATE UNIQUE INDEX "DocumentCurrentProjection_documentId_idempotencyKey_key"
ON "DocumentCurrentProjection"("documentId", "idempotencyKey");

DROP TYPE "DocumentCollabRuntimeRole";
DROP TYPE "DocumentCollaborationPermission";
DROP TYPE "DocumentCollaborationScope";
DROP TYPE "DocumentCollaborationGrantSourceType";
DROP TYPE "DocumentCollaborationGrantStatus";
DROP TYPE "DocumentCollaborationUserInviteStatus";
DROP TYPE "CollaborationResolverEntryType";
DROP TYPE "CollaborationResolverEntryStatus";

COMMIT;
