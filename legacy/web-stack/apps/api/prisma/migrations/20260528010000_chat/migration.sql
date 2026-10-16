-- CreateEnum
CREATE TYPE "ChatSessionOrigin" AS ENUM ('GLOBAL', 'DOCS');

-- AlterTable
ALTER TABLE "ChatSession"
ADD COLUMN "origin" "ChatSessionOrigin" NOT NULL DEFAULT 'GLOBAL';

-- CreateTable
CREATE TABLE "ChatMessageContextSnapshot" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "scope" JSONB NOT NULL,
  "size" INTEGER NOT NULL,
  "sourceAttachmentIds" JSONB NOT NULL,
  "content" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChatMessageContextSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatSession_userId_origin_updatedAt_idx" ON "ChatSession"("userId", "origin", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatMessageContextSnapshot_messageId_idx" ON "ChatMessageContextSnapshot"("messageId");

-- CreateIndex
CREATE INDEX "ChatMessageContextSnapshot_documentId_idx" ON "ChatMessageContextSnapshot"("documentId");

-- AddForeignKey
ALTER TABLE "ChatMessageContextSnapshot"
ADD CONSTRAINT "ChatMessageContextSnapshot_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "ChatSessionMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
