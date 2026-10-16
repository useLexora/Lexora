-- CreateEnum
CREATE TYPE "ChatMessageGenerationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AgentProfile" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "avatarUrl" TEXT,
    "currentConfig" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AgentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessageGeneration" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "triggerUserMessageId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "agentProfileId" TEXT,
    "agentProfileSnapshot" JSONB NOT NULL,
    "modelTargetSnapshot" JSONB NOT NULL,
    "status" "ChatMessageGenerationStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "commandPublishedAt" TIMESTAMP(3),
    "dispatchLeaseExpiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatMessageGeneration_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN "agentProfileId" TEXT,
ADD COLUMN "modelOverrideProviderId" TEXT,
ADD COLUMN "modelOverrideModelId" TEXT;

-- AlterTable
ALTER TABLE "ChatSessionRun" DROP COLUMN "workflowKey";

-- BackfillData
UPDATE "ChatSession"
SET "modelOverrideProviderId" = "selectedProviderId",
    "modelOverrideModelId" = "selectedModelId"
WHERE "selectedProviderId" IS NOT NULL
  AND "selectedModelId" IS NOT NULL
  AND "modelOverrideProviderId" IS NULL
  AND "modelOverrideModelId" IS NULL;

-- CreateIndex
CREATE INDEX "AgentProfile_ownerUserId_isDefault_deletedAt_idx" ON "AgentProfile"("ownerUserId", "isDefault", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_default_ownerUserId_key" ON "AgentProfile"("ownerUserId") WHERE "isDefault" = true AND "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "AgentProfile_ownerUserId_deletedAt_idx" ON "AgentProfile"("ownerUserId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessageGeneration_generationId_key" ON "ChatMessageGeneration"("generationId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessageGeneration_assistantMessageId_key" ON "ChatMessageGeneration"("assistantMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessageGeneration_idempotencyKey_key" ON "ChatMessageGeneration"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ChatMessageGeneration_sessionId_status_idx" ON "ChatMessageGeneration"("sessionId", "status");

-- CreateIndex
CREATE INDEX "ChatMessageGeneration_status_commandPublishedAt_dispatchLeaseExpiresAt_idx" ON "ChatMessageGeneration"("status", "commandPublishedAt", "dispatchLeaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessageGeneration_one_active_per_session_key" ON "ChatMessageGeneration"("sessionId") WHERE "deletedAt" IS NULL AND "status" IN ('PENDING', 'RUNNING');

-- CreateIndex
CREATE INDEX "ChatMessageGeneration_triggerUserMessageId_idx" ON "ChatMessageGeneration"("triggerUserMessageId");

-- CreateIndex
CREATE INDEX "ChatMessageGeneration_actorUserId_createdAt_idx" ON "ChatMessageGeneration"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessageGeneration_agentProfileId_idx" ON "ChatMessageGeneration"("agentProfileId");

-- CreateIndex
CREATE INDEX "ChatSession_agentProfileId_idx" ON "ChatSession"("agentProfileId");

-- CreateIndex
CREATE INDEX "ChatSession_modelOverrideProviderId_idx" ON "ChatSession"("modelOverrideProviderId");

-- AddForeignKey
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageGeneration" ADD CONSTRAINT "ChatMessageGeneration_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageGeneration" ADD CONSTRAINT "ChatMessageGeneration_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "ChatSessionMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageGeneration" ADD CONSTRAINT "ChatMessageGeneration_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DeleteData
DELETE FROM "AiDefaultModelPolicy"
WHERE "intentKey" IN ('document.default', 'document.generate.default', 'document.rewrite.default');

-- DropTable
DROP TABLE IF EXISTS "AiCandidate" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "AiRun" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "AiSession" CASCADE;

-- DropEnum
DROP TYPE IF EXISTS "AiCandidateStatus";

-- DropEnum
DROP TYPE IF EXISTS "AiRunStatus";

-- DropEnum
DROP TYPE IF EXISTS "AiSessionStatus";

-- DropEnum
DROP TYPE IF EXISTS "AiAnchorKind";
