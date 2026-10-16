-- CreateEnum
CREATE TYPE "AgentRuntimeCleanupTaskStatus" AS ENUM ('PENDING', 'DISPATCHED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "AgentRuntimeCleanupTask" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "status" "AgentRuntimeCleanupTaskStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "controlId" TEXT,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "controlPublishedAt" TIMESTAMP(3),
    "controlLeaseExpiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRuntimeCleanupTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRuntimeCleanupTask_scope_resourceId_threadId_key" ON "AgentRuntimeCleanupTask"("scope", "resourceId", "threadId");

-- CreateIndex
CREATE INDEX "AgentRuntimeCleanupTask_status_nextAttemptAt_idx" ON "AgentRuntimeCleanupTask"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AgentRuntimeCleanupTask_status_controlLeaseExpiresAt_idx" ON "AgentRuntimeCleanupTask"("status", "controlLeaseExpiresAt");

-- CreateIndex
CREATE INDEX "AgentRuntimeCleanupTask_controlId_idx" ON "AgentRuntimeCleanupTask"("controlId");

-- CreateIndex
CREATE INDEX "AgentRuntimeCleanupTask_threadId_idx" ON "AgentRuntimeCleanupTask"("threadId");
