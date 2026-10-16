-- CreateEnum
ALTER TYPE "ChatSessionMessageStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "ChatSessionMessageStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- CreateEnum
CREATE TYPE "ChatSessionRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChatSessionEventType" AS ENUM (
    'MESSAGE_CREATED',
    'MESSAGE_STATUS_CHANGED',
    'MESSAGE_PART_DELTA',
    'MESSAGE_COMPLETED',
    'MESSAGE_FAILED',
    'MESSAGE_CANCELLED',
    'RUN_STARTED',
    'RUN_COMPLETED',
    'RUN_FAILED',
    'RUN_CANCELLED',
    'BRANCH_SWITCHED',
    'TITLE_UPDATED',
    'SNAPSHOT_REQUIRED'
);

-- DropIndex
DROP INDEX IF EXISTS "ChatSessionMessage_sessionId_order_key";

-- AlterTable
ALTER TABLE "ChatSession"
ADD COLUMN "activeRootMessageId" TEXT,
ADD COLUMN "activeLeafMessageId" TEXT,
ADD COLUMN "nextEventSequence" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ChatSessionMessage"
ADD COLUMN "parentMessageId" TEXT,
ADD COLUMN "selectedChildMessageId" TEXT,
ADD COLUMN "branchOrder" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "sourceMessageId" TEXT;

-- Backfill existing linear chat history into the new active branch tree.
WITH ordered_messages AS (
    SELECT
        "id",
        "sessionId",
        LAG("id") OVER (
            PARTITION BY "sessionId"
            ORDER BY "order" ASC, "createdAt" ASC, "id" ASC
        ) AS "parentMessageId",
        LEAD("id") OVER (
            PARTITION BY "sessionId"
            ORDER BY "order" ASC, "createdAt" ASC, "id" ASC
        ) AS "selectedChildMessageId"
    FROM "ChatSessionMessage"
)
UPDATE "ChatSessionMessage" AS message
SET
    "parentMessageId" = ordered_messages."parentMessageId",
    "selectedChildMessageId" = ordered_messages."selectedChildMessageId",
    "branchOrder" = 1
FROM ordered_messages
WHERE message."id" = ordered_messages."id";

WITH first_user_messages AS (
    SELECT DISTINCT ON ("sessionId")
        "sessionId",
        "id"
    FROM "ChatSessionMessage"
    WHERE "role" = 'USER'::"ChatSessionMessageRole"
    ORDER BY "sessionId" ASC, "order" ASC, "createdAt" ASC, "id" ASC
),
last_messages AS (
    SELECT DISTINCT ON ("sessionId")
        "sessionId",
        "id"
    FROM "ChatSessionMessage"
    ORDER BY "sessionId" ASC, "order" DESC, "createdAt" DESC, "id" DESC
)
UPDATE "ChatSession" AS session
SET
    "activeRootMessageId" = first_user_messages."id",
    "activeLeafMessageId" = last_messages."id"
FROM first_user_messages
JOIN last_messages ON last_messages."sessionId" = first_user_messages."sessionId"
WHERE session."id" = first_user_messages."sessionId";

-- AlterTable
ALTER TABLE "ChatSessionMessage"
DROP COLUMN "order";

-- CreateTable
CREATE TABLE "ChatSessionRun" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "triggerUserMessageId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "modelTargetSnapshot" JSONB,
    "commandContext" JSONB NOT NULL,
    "status" "ChatSessionRunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatSessionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSessionEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "ChatSessionEventType" NOT NULL,
    "messageId" TEXT,
    "runId" TEXT,
    "payload" JSONB NOT NULL,
    "sourceEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatSession_activeRootMessageId_idx" ON "ChatSession"("activeRootMessageId");

-- CreateIndex
CREATE INDEX "ChatSession_activeLeafMessageId_idx" ON "ChatSession"("activeLeafMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSessionMessage_sessionId_parentMessageId_role_branchOrder_key" ON "ChatSessionMessage"("sessionId", "parentMessageId", "role", "branchOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSessionMessage_root_role_branchOrder_key" ON "ChatSessionMessage"("sessionId", "role", "branchOrder")
WHERE "parentMessageId" IS NULL;

-- CreateIndex
CREATE INDEX "ChatSessionMessage_sessionId_parentMessageId_role_idx" ON "ChatSessionMessage"("sessionId", "parentMessageId", "role");

-- CreateIndex
CREATE INDEX "ChatSessionMessage_selectedChildMessageId_idx" ON "ChatSessionMessage"("selectedChildMessageId");

-- CreateIndex
CREATE INDEX "ChatSessionMessage_sourceMessageId_idx" ON "ChatSessionMessage"("sourceMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSessionRun_runId_key" ON "ChatSessionRun"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSessionRun_assistantMessageId_key" ON "ChatSessionRun"("assistantMessageId");

-- CreateIndex
CREATE INDEX "ChatSessionRun_sessionId_status_idx" ON "ChatSessionRun"("sessionId", "status");

-- CreateIndex
CREATE INDEX "ChatSessionRun_triggerUserMessageId_idx" ON "ChatSessionRun"("triggerUserMessageId");

-- CreateIndex
CREATE INDEX "ChatSessionRun_actorUserId_createdAt_idx" ON "ChatSessionRun"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSessionRun_one_active_per_session_key" ON "ChatSessionRun"("sessionId")
WHERE "status" IN ('PENDING', 'RUNNING');

-- CreateIndex
CREATE UNIQUE INDEX "ChatSessionEvent_sessionId_sequence_key" ON "ChatSessionEvent"("sessionId", "sequence");

-- CreateIndex
CREATE INDEX "ChatSessionEvent_sessionId_createdAt_idx" ON "ChatSessionEvent"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatSessionEvent_runId_idx" ON "ChatSessionEvent"("runId");

-- CreateIndex
CREATE INDEX "ChatSessionEvent_messageId_idx" ON "ChatSessionEvent"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSessionEvent_runId_sourceEventId_key" ON "ChatSessionEvent"("runId", "sourceEventId")
WHERE "runId" IS NOT NULL AND "sourceEventId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_activeRootMessageId_fkey" FOREIGN KEY ("activeRootMessageId") REFERENCES "ChatSessionMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_activeLeafMessageId_fkey" FOREIGN KEY ("activeLeafMessageId") REFERENCES "ChatSessionMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSessionMessage" ADD CONSTRAINT "ChatSessionMessage_parentMessageId_fkey" FOREIGN KEY ("parentMessageId") REFERENCES "ChatSessionMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSessionMessage" ADD CONSTRAINT "ChatSessionMessage_selectedChildMessageId_fkey" FOREIGN KEY ("selectedChildMessageId") REFERENCES "ChatSessionMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSessionMessage" ADD CONSTRAINT "ChatSessionMessage_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "ChatSessionMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSessionRun" ADD CONSTRAINT "ChatSessionRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSessionRun" ADD CONSTRAINT "ChatSessionRun_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "ChatSessionMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSessionEvent" ADD CONSTRAINT "ChatSessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSessionEvent" ADD CONSTRAINT "ChatSessionEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatSessionMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSessionEvent" ADD CONSTRAINT "ChatSessionEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ChatSessionRun"("runId") ON DELETE SET NULL ON UPDATE CASCADE;
