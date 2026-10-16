-- AlterTable
ALTER TABLE "ChatSession"
ADD COLUMN "selectedModelServiceConfigId" TEXT,
ADD COLUMN "selectedModelId" TEXT;

-- CreateIndex
CREATE INDEX "ChatSession_selectedModelServiceConfigId_idx" ON "ChatSession"("selectedModelServiceConfigId");
