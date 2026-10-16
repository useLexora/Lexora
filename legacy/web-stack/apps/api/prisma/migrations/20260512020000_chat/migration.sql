-- AlterTable
ALTER TABLE "ChatSessionRun"
ADD COLUMN "commandPublishedAt" TIMESTAMP(3),
ADD COLUMN "dispatchLeaseExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ChatSessionRun_status_commandPublishedAt_dispatchLeaseExpiresAt_idx" ON "ChatSessionRun"("status", "commandPublishedAt", "dispatchLeaseExpiresAt");
