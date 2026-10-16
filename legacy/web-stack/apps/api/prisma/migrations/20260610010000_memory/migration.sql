-- CreateEnum
CREATE TYPE "AgentMemoryOperationMode" AS ENUM ('DIRECT', 'PENDING_CONFIRMATION', 'BACKGROUND_SUGGESTION', 'IGNORED');

-- CreateEnum
CREATE TYPE "AgentMemoryOperationAction" AS ENUM ('CREATE', 'APPEND', 'UPDATE', 'DISABLE', 'FORGET', 'IGNORE', 'ASK_USER');

-- CreateEnum
CREATE TYPE "AgentMemoryCandidateStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AgentMemoryCandidateKind" AS ENUM ('PROFILE', 'PREFERENCE', 'FEEDBACK', 'PROJECT_REFERENCE', 'TASK_KNOWLEDGE', 'FORGET_REQUEST');

-- CreateTable
CREATE TABLE "AgentMemoryCandidate" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "agentProfileId" TEXT,
    "sessionId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "sourceGenerationId" TEXT,
    "kind" "AgentMemoryCandidateKind" NOT NULL,
    "action" "AgentMemoryOperationAction" NOT NULL,
    "mode" "AgentMemoryOperationMode" NOT NULL,
    "status" "AgentMemoryCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "scope" "AgentMemoryScope" NOT NULL,
    "lane" "AgentMemoryLane" NOT NULL,
    "slotKey" TEXT,
    "slotValue" TEXT,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "reason" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sensitivity" "AgentMemorySensitivity" NOT NULL DEFAULT 'NORMAL',
    "relatedMemoryIds" JSONB NOT NULL DEFAULT '[]',
    "resultMemoryIds" JSONB NOT NULL DEFAULT '[]',
    "operation" JSONB NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AgentMemoryCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentMemoryCandidate_ownerUserId_status_createdAt_idx" ON "AgentMemoryCandidate"("ownerUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentMemoryCandidate_agentProfileId_status_idx" ON "AgentMemoryCandidate"("agentProfileId", "status");

-- CreateIndex
CREATE INDEX "AgentMemoryCandidate_sessionId_createdAt_idx" ON "AgentMemoryCandidate"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentMemoryCandidate_sourceMessageId_idx" ON "AgentMemoryCandidate"("sourceMessageId");

-- CreateIndex
CREATE INDEX "AgentMemoryCandidate_sourceGenerationId_idx" ON "AgentMemoryCandidate"("sourceGenerationId");

-- AddForeignKey
ALTER TABLE "AgentMemoryCandidate" ADD CONSTRAINT "AgentMemoryCandidate_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemoryCandidate" ADD CONSTRAINT "AgentMemoryCandidate_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemoryCandidate" ADD CONSTRAINT "AgentMemoryCandidate_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemoryCandidate" ADD CONSTRAINT "AgentMemoryCandidate_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "ChatSessionMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemoryCandidate" ADD CONSTRAINT "AgentMemoryCandidate_sourceGenerationId_fkey" FOREIGN KEY ("sourceGenerationId") REFERENCES "ChatMessageGeneration"("generationId") ON DELETE SET NULL ON UPDATE CASCADE;
