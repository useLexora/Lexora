-- CreateExtension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "AgentMemoryScope" AS ENUM ('USER', 'USER_AGENT');

-- CreateEnum
CREATE TYPE "AgentMemoryLane" AS ENUM ('USER_PROFILE', 'USER_PREFERENCE', 'USER_FEEDBACK', 'AGENT_PERSONALIZATION', 'PROJECT_REFERENCE', 'TASK_KNOWLEDGE');

-- CreateEnum
CREATE TYPE "AgentMemoryStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AgentMemorySensitivity" AS ENUM ('NORMAL', 'SENSITIVE');

-- CreateEnum
CREATE TYPE "AgentMemorySourceType" AS ENUM ('MANUAL', 'USER_FEEDBACK', 'IMPORTED');

-- CreateTable
CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL,
    "scope" "AgentMemoryScope" NOT NULL,
    "lane" "AgentMemoryLane" NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "agentProfileId" TEXT,
    "slotKey" TEXT,
    "slotValue" TEXT,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "sensitivity" "AgentMemorySensitivity" NOT NULL DEFAULT 'NORMAL',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "sourceType" "AgentMemorySourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceSessionId" TEXT,
    "sourceMessageId" TEXT,
    "sourceGenerationId" TEXT,
    "status" "AgentMemoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesMemoryId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "acceptedByUserId" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMemorySearchIndex" (
    "id" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "scope" "AgentMemoryScope" NOT NULL,
    "lane" "AgentMemoryLane" NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "agentProfileId" TEXT,
    "searchText" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector,
    "embeddingModelProviderKey" TEXT,
    "embeddingModelId" TEXT,
    "embeddingDimensions" INTEGER,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMemorySearchIndex_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentMemory_ownerUserId_scope_lane_status_idx" ON "AgentMemory"("ownerUserId", "scope", "lane", "status");

-- CreateIndex
CREATE INDEX "AgentMemory_ownerUserId_status_updatedAt_idx" ON "AgentMemory"("ownerUserId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentMemory_agentProfileId_status_idx" ON "AgentMemory"("agentProfileId", "status");

-- CreateIndex
CREATE INDEX "AgentMemory_supersedesMemoryId_idx" ON "AgentMemory"("supersedesMemoryId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMemory_active_slot_unique_idx" ON "AgentMemory"(
  "ownerUserId",
  "scope",
  "lane",
  COALESCE("agentProfileId", ''),
  "slotKey"
) WHERE "slotKey" IS NOT NULL AND "status" = 'ACTIVE' AND "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AgentMemorySearchIndex_memoryId_key" ON "AgentMemorySearchIndex"("memoryId");

-- CreateIndex
CREATE INDEX "AgentMemorySearchIndex_ownerUserId_scope_lane_idx" ON "AgentMemorySearchIndex"("ownerUserId", "scope", "lane");

-- CreateIndex
CREATE INDEX "AgentMemorySearchIndex_agentProfileId_idx" ON "AgentMemorySearchIndex"("agentProfileId");

-- CreateIndex
CREATE INDEX "AgentMemorySearchIndex_contentHash_idx" ON "AgentMemorySearchIndex"("contentHash");

-- CreateIndex
CREATE INDEX "AgentMemorySearchIndex_searchText_fts_idx" ON "AgentMemorySearchIndex" USING GIN (to_tsvector('simple', "searchText"));

-- AddForeignKey
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemorySearchIndex" ADD CONSTRAINT "AgentMemorySearchIndex_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "AgentMemory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BackfillData
UPDATE "AgentProfile"
SET "currentConfig" = jsonb_set(
  "currentConfig"::jsonb,
  '{memoryPolicy}',
  jsonb_build_object(
    'enabled', true,
    'ignoredForRun', false,
    'scopes', '["user","user_agent"]'::jsonb,
    'lanes', '["user_profile","user_preference","user_feedback","agent_personalization","project_reference","task_knowledge"]'::jsonb,
    'perLaneTopK', '{}'::jsonb,
    'perLaneBudget', '{}'::jsonb,
    'maxInjectedTokens', 1200,
    'includeSensitive', false
  )
  || COALESCE("currentConfig"::jsonb->'memoryPolicy', '{}'::jsonb)
  || '{"enabled": true}'::jsonb,
  true
)
WHERE jsonb_typeof("currentConfig"::jsonb) = 'object';
