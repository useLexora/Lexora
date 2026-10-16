-- CreateEnum
CREATE TYPE "ChatSessionMessageStatus" AS ENUM ('STREAMING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ChatSessionMessagePartType" AS ENUM ('REASONING', 'TEXT', 'TOOL_CALL', 'TOOL_RESULT', 'SOURCE', 'CITATION');

-- AlterTable
ALTER TABLE "ChatSessionMessage"
ADD COLUMN "status" "ChatSessionMessageStatus" NOT NULL DEFAULT 'COMPLETED',
ADD COLUMN "agentRunId" TEXT,
ADD COLUMN "metadata" JSONB,
ADD COLUMN "completedAt" TIMESTAMP(3);

UPDATE "ChatSessionMessage"
SET "completedAt" = "updatedAt"
WHERE "completedAt" IS NULL;

-- CreateTable
CREATE TABLE "ChatSessionMessagePart" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" "ChatSessionMessagePartType" NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatSessionMessagePart_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ChatSessionMessagePart" (
    "id",
    "messageId",
    "type",
    "text",
    "order",
    "createdAt",
    "updatedAt"
)
SELECT
    CONCAT("id", ':text'),
    "id",
    'TEXT'::"ChatSessionMessagePartType",
    "content",
    CASE
        WHEN "role" = 'ASSISTANT'::"ChatSessionMessageRole" THEN 1
        ELSE 0
    END,
    "createdAt",
    "updatedAt"
FROM "ChatSessionMessage"
WHERE "content" <> '';

-- CreateIndex
CREATE INDEX "ChatSessionMessage_agentRunId_idx" ON "ChatSessionMessage"("agentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSessionMessagePart_messageId_order_key" ON "ChatSessionMessagePart"("messageId", "order");

-- CreateIndex
CREATE INDEX "ChatSessionMessagePart_messageId_type_idx" ON "ChatSessionMessagePart"("messageId", "type");

-- AddForeignKey
ALTER TABLE "ChatSessionMessagePart" ADD CONSTRAINT "ChatSessionMessagePart_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatSessionMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
