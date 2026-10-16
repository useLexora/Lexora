-- CreateEnum
CREATE TYPE "AgentSkillSourceScope" AS ENUM ('BUILTIN', 'MARKET');

-- CreateEnum
CREATE TYPE "AgentSkillTrustLevel" AS ENUM ('TRUSTED', 'REVIEW_REQUIRED', 'QUARANTINED');

-- CreateTable
CREATE TABLE "AgentSkill" (
    "id" TEXT NOT NULL,
    "scope" "AgentSkillSourceScope" NOT NULL DEFAULT 'MARKET',
    "skillKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "activationMode" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "version" TEXT,
    "sourcePath" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "skillMdPath" TEXT NOT NULL,
    "packageHash" TEXT NOT NULL,
    "frontmatter" JSONB NOT NULL,
    "instructions" TEXT NOT NULL,
    "trustLevel" "AgentSkillTrustLevel" NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AgentSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSkillFile" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "relPath" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "executable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSkillFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkill_skillKey_key" ON "AgentSkill"("skillKey");

-- CreateIndex
CREATE INDEX "AgentSkill_scope_enabled_deletedAt_idx" ON "AgentSkill"("scope", "enabled", "deletedAt");

-- CreateIndex
CREATE INDEX "AgentSkill_skillKey_enabled_deletedAt_idx" ON "AgentSkill"("skillKey", "enabled", "deletedAt");

-- CreateIndex
CREATE INDEX "AgentSkill_sourcePath_idx" ON "AgentSkill"("sourcePath");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkillFile_skillId_relPath_key" ON "AgentSkillFile"("skillId", "relPath");

-- CreateIndex
CREATE INDEX "AgentSkillFile_skillId_idx" ON "AgentSkillFile"("skillId");

-- AddForeignKey
ALTER TABLE "AgentSkillFile" ADD CONSTRAINT "AgentSkillFile_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "AgentSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
