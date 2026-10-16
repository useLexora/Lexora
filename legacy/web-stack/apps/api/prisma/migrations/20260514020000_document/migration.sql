CREATE TYPE "DocumentVersionSnapshotSource" AS ENUM ('initial', 'user', 'auto', 'restore');

ALTER TABLE "Document"
ADD COLUMN "versionSnapshotSeq" INTEGER NOT NULL DEFAULT 0;

UPDATE "Document" AS document
SET "versionSnapshotSeq" = COALESCE(snapshot.latest_version, 0)
FROM (
  SELECT "documentId", MAX("version") AS latest_version
  FROM "DocumentVersionSnapshot"
  WHERE "deletedAt" IS NULL
  GROUP BY "documentId"
) AS snapshot
WHERE document."id" = snapshot."documentId";

ALTER TABLE "DocumentVersionSnapshot"
ADD COLUMN "basedOnProjectionId" TEXT,
ADD COLUMN "projectedUpdateSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "checkpointSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "checkpointUpdateSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "label" TEXT;

UPDATE "DocumentVersionSnapshot" AS snapshot
SET
  "basedOnProjectionId" = projection."id",
  "projectedUpdateSeq" = projection."projectedUpdateSeq",
  "checkpointSeq" = projection."checkpointSeq",
  "checkpointUpdateSeq" = projection."checkpointUpdateSeq"
FROM "DocumentCurrentProjection" AS projection
WHERE snapshot."documentId" = projection."documentId"
  AND snapshot."basedOnProjectionRevision" = projection."projectionRevision"
  AND snapshot."deletedAt" IS NULL
  AND projection."deletedAt" IS NULL;

ALTER TABLE "DocumentVersionSnapshot"
ALTER COLUMN "source" TYPE "DocumentVersionSnapshotSource"
USING "source"::"DocumentVersionSnapshotSource";

CREATE UNIQUE INDEX "DocumentVersionSnapshot_documentId_idempotencyKey_key"
ON "DocumentVersionSnapshot"("documentId", "idempotencyKey");

CREATE INDEX "DocumentVersionSnapshot_basedOnProjectionId_idx"
ON "DocumentVersionSnapshot"("basedOnProjectionId");

CREATE INDEX "DocumentVersionSnapshot_documentId_runtimeEpoch_checkpoint_idx"
ON "DocumentVersionSnapshot"("documentId", "runtimeEpoch", "checkpointUpdateSeq");

ALTER TABLE "DocumentVersionSnapshot"
ADD CONSTRAINT "DocumentVersionSnapshot_basedOnProjectionId_fkey"
FOREIGN KEY ("basedOnProjectionId") REFERENCES "DocumentCurrentProjection"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
