CREATE TYPE "ChatAssetKind" AS ENUM ('IMAGE', 'FILE');

CREATE TYPE "ChatAssetStatus" AS ENUM ('READY');

CREATE TABLE "ChatAsset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "sessionId" TEXT,
    "messageId" TEXT,
    "kind" "ChatAssetKind" NOT NULL,
    "status" "ChatAssetStatus" NOT NULL DEFAULT 'READY',
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatAsset_workspaceId_ownerUserId_createdAt_idx" ON "ChatAsset"("workspaceId", "ownerUserId", "createdAt");

CREATE INDEX "ChatAsset_sessionId_idx" ON "ChatAsset"("sessionId");

CREATE INDEX "ChatAsset_messageId_idx" ON "ChatAsset"("messageId");

CREATE INDEX "ChatAsset_ownerUserId_createdAt_idx" ON "ChatAsset"("ownerUserId", "createdAt");

ALTER TABLE "ChatAsset" ADD CONSTRAINT "ChatAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatAsset" ADD CONSTRAINT "ChatAsset_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatAsset" ADD CONSTRAINT "ChatAsset_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChatAsset" ADD CONSTRAINT "ChatAsset_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatSessionMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
