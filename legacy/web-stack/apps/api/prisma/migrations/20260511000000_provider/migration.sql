-- CreateEnum
CREATE TYPE "AiProviderSource" AS ENUM ('PRESET', 'COMPATIBLE');

-- RenameEnum
ALTER TYPE "AiModelServiceScope" RENAME TO "AiProviderScope";
ALTER TYPE "AiModelEndpointMode" RENAME TO "AiProviderEndpointMode";
ALTER TYPE "AiModelAuthMode" RENAME TO "AiProviderAuthMode";
ALTER TYPE "AiModelServiceVisibility" RENAME TO "AiProviderVisibility";

-- RenameTable
ALTER TABLE "AiModelServiceConfig" RENAME TO "AiProvider";
ALTER TABLE "AiModelItem" RENAME TO "AiProviderModel";

-- RenameColumn
ALTER TABLE "AiProviderModel" RENAME COLUMN "serviceConfigId" TO "providerId";
ALTER TABLE "AiDefaultModelPolicy" RENAME COLUMN "serviceConfigId" TO "providerId";
ALTER TABLE "ChatSession" RENAME COLUMN "selectedModelServiceConfigId" TO "selectedProviderId";

-- AlterTable
ALTER TABLE "AiProvider"
ADD COLUMN "ownerKey" TEXT,
ADD COLUMN "identityKey" TEXT,
ADD COLUMN "source" "AiProviderSource";

UPDATE "AiProvider"
SET "ownerKey" = CASE
  WHEN "scope"::TEXT = 'SYSTEM' THEN 'system'
  WHEN "ownerUserId" IS NOT NULL THEN CONCAT('user:', "ownerUserId")
  ELSE CONCAT('user:orphan:', "id")
END;

WITH builtin_providers AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "ownerKey", "providerKey"
      ORDER BY "updatedAt" DESC, "id"
    ) AS "position"
  FROM "AiProvider"
  WHERE "providerKey" IN ('openai', 'deepseek', 'anthropic')
)
UPDATE "AiProvider" AS provider
SET
  "source" = CASE
    WHEN builtin_providers."position" = 1 THEN 'PRESET'::"AiProviderSource"
    ELSE 'COMPATIBLE'::"AiProviderSource"
  END,
  "identityKey" = CASE
    WHEN builtin_providers."position" = 1 THEN provider."providerKey"
    ELSE provider."id"
  END
FROM builtin_providers
WHERE provider."id" = builtin_providers."id";

UPDATE "AiProvider"
SET
  "source" = 'COMPATIBLE'::"AiProviderSource",
  "identityKey" = "id"
WHERE "source" IS NULL;

ALTER TABLE "AiProvider"
ALTER COLUMN "ownerKey" SET NOT NULL,
ALTER COLUMN "identityKey" SET NOT NULL,
ALTER COLUMN "source" SET NOT NULL;

-- RenameConstraint
ALTER TABLE "AiProvider" RENAME CONSTRAINT "AiModelServiceConfig_pkey" TO "AiProvider_pkey";
ALTER TABLE "AiProviderModel" RENAME CONSTRAINT "AiModelItem_pkey" TO "AiProviderModel_pkey";
ALTER TABLE "AiProvider" RENAME CONSTRAINT "AiModelServiceConfig_ownerUserId_fkey" TO "AiProvider_ownerUserId_fkey";
ALTER TABLE "AiProvider" RENAME CONSTRAINT "AiModelServiceConfig_updatedBy_fkey" TO "AiProvider_updatedBy_fkey";
ALTER TABLE "AiProviderModel" RENAME CONSTRAINT "AiModelItem_serviceConfigId_fkey" TO "AiProviderModel_providerId_fkey";
ALTER TABLE "AiProviderModel" RENAME CONSTRAINT "AiModelItem_updatedBy_fkey" TO "AiProviderModel_updatedBy_fkey";
ALTER TABLE "AiDefaultModelPolicy" RENAME CONSTRAINT "AiDefaultModelPolicy_serviceConfigId_fkey" TO "AiDefaultModelPolicy_providerId_fkey";

-- RenameIndex
ALTER INDEX "AiModelServiceConfig_scope_enabled_idx" RENAME TO "AiProvider_scope_enabled_idx";
ALTER INDEX "AiModelServiceConfig_ownerUserId_enabled_idx" RENAME TO "AiProvider_ownerUserId_enabled_idx";
ALTER INDEX "AiModelServiceConfig_providerKey_idx" RENAME TO "AiProvider_providerKey_idx";
ALTER INDEX "AiModelServiceConfig_updatedBy_idx" RENAME TO "AiProvider_updatedBy_idx";
ALTER INDEX "AiModelItem_serviceConfigId_enabled_idx" RENAME TO "AiProviderModel_providerId_enabled_idx";
ALTER INDEX "AiModelItem_modelType_idx" RENAME TO "AiProviderModel_modelType_idx";
ALTER INDEX "AiModelItem_updatedBy_idx" RENAME TO "AiProviderModel_updatedBy_idx";
ALTER INDEX "AiModelItem_serviceConfigId_modelId_key" RENAME TO "AiProviderModel_providerId_modelId_key";
ALTER INDEX "AiDefaultModelPolicy_serviceConfigId_idx" RENAME TO "AiDefaultModelPolicy_providerId_idx";
ALTER INDEX "ChatSession_selectedModelServiceConfigId_idx" RENAME TO "ChatSession_selectedProviderId_idx";

-- CreateIndex
CREATE INDEX "AiProvider_ownerKey_providerKey_idx" ON "AiProvider"("ownerKey", "providerKey");

-- CreateIndex
CREATE UNIQUE INDEX "AiProvider_ownerKey_identityKey_key" ON "AiProvider"("ownerKey", "identityKey");
