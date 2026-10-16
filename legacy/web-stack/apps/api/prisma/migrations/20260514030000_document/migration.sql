CREATE TYPE "DocumentOperationJobType" AS ENUM ('DUPLICATE_TREE', 'MOVE_TREE');

CREATE TYPE "DocumentOperationJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "DocumentOperationJob" (
  "id" TEXT NOT NULL,
  "type" "DocumentOperationJobType" NOT NULL,
  "status" "DocumentOperationJobStatus" NOT NULL DEFAULT 'PENDING',
  "sourceDocumentId" TEXT,
  "targetWorkspaceId" TEXT,
  "targetParentId" TEXT,
  "targetVisibility" "DocumentVisibility",
  "documentsTotal" INTEGER NOT NULL DEFAULT 0,
  "documentsDone" INTEGER NOT NULL DEFAULT 0,
  "assetsTotal" INTEGER NOT NULL DEFAULT 0,
  "assetsDone" INTEGER NOT NULL DEFAULT 0,
  "resultDocumentId" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "DocumentOperationJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DocumentOperationJob_createdBy_status_updatedAt_idx"
ON "DocumentOperationJob"("createdBy", "status", "updatedAt");

CREATE INDEX "DocumentOperationJob_sourceDocumentId_status_idx"
ON "DocumentOperationJob"("sourceDocumentId", "status");

CREATE INDEX "DocumentOperationJob_resultDocumentId_idx"
ON "DocumentOperationJob"("resultDocumentId");

ALTER TABLE "DocumentOperationJob"
ADD CONSTRAINT "DocumentOperationJob_sourceDocumentId_fkey"
FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DocumentOperationJob"
ADD CONSTRAINT "DocumentOperationJob_resultDocumentId_fkey"
FOREIGN KEY ("resultDocumentId") REFERENCES "Document"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DocumentOperationJob"
ADD CONSTRAINT "DocumentOperationJob_createdBy_fkey"
FOREIGN KEY ("createdBy") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
