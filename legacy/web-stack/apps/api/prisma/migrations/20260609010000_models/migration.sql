-- CreateEnum
CREATE TYPE "AiModelModality" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'FILE', 'EMBEDDING');

-- AlterEnum
ALTER TYPE "AiModelType" ADD VALUE IF NOT EXISTS 'AUDIO';

-- AlterTable
ALTER TABLE "AiProviderModel" ADD COLUMN "inputModalities" "AiModelModality"[],
ADD COLUMN "outputModalities" "AiModelModality"[],
ADD COLUMN "capabilityConfiguredAt" TIMESTAMP(3);

-- BackfillData
UPDATE "AiProviderModel"
SET "inputModalities" = CASE
      WHEN COALESCE("capabilities", ARRAY[]::"AiModelCapability"[]) @> ARRAY['VISION'::"AiModelCapability"]
        THEN ARRAY['TEXT', 'IMAGE']::"AiModelModality"[]
      WHEN "modelType" = 'EMBEDDING'
        THEN ARRAY['TEXT']::"AiModelModality"[]
      WHEN "modelType" = 'RERANK'
        THEN ARRAY['TEXT']::"AiModelModality"[]
      WHEN "modelType" = 'IMAGE'
        THEN ARRAY['TEXT']::"AiModelModality"[]
      ELSE ARRAY['TEXT']::"AiModelModality"[]
    END,
    "outputModalities" = CASE
      WHEN COALESCE("capabilities", ARRAY[]::"AiModelCapability"[]) @> ARRAY['VISION'::"AiModelCapability"]
        THEN ARRAY['TEXT']::"AiModelModality"[]
      WHEN "modelType" = 'EMBEDDING'
        THEN ARRAY['EMBEDDING']::"AiModelModality"[]
      WHEN "modelType" = 'RERANK'
        THEN ARRAY['TEXT']::"AiModelModality"[]
      WHEN "modelType" = 'IMAGE'
        THEN ARRAY['IMAGE']::"AiModelModality"[]
      ELSE ARRAY['TEXT']::"AiModelModality"[]
    END;

-- RecreateEnum
UPDATE "AiProviderModel"
SET "capabilities" = array_remove("capabilities", 'VISION'::"AiModelCapability")
WHERE "capabilities" IS NOT NULL;

ALTER TYPE "AiModelCapability" RENAME TO "AiModelCapability_old";
CREATE TYPE "AiModelCapability" AS ENUM ('STREAMING', 'TOOL_CALL', 'REASONING', 'JSON_MODE', 'STRUCTURED_OUTPUT');
ALTER TABLE "AiProviderModel"
ALTER COLUMN "capabilities" TYPE "AiModelCapability"[] USING "capabilities"::text[]::"AiModelCapability"[];
DROP TYPE "AiModelCapability_old";

-- BackfillData
UPDATE "AiProviderModel"
SET "capabilities" = ARRAY[]::"AiModelCapability"[]
WHERE "capabilities" IS NULL;

-- AlterTable
ALTER TABLE "AiProviderModel" ALTER COLUMN "capabilities" SET NOT NULL,
ALTER COLUMN "inputModalities" SET NOT NULL,
ALTER COLUMN "outputModalities" SET NOT NULL;

-- CreateTable
CREATE TABLE "AiModelCapabilityDefault" (
    "id" TEXT NOT NULL,
    "defaultsVersion" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelType" "AiModelType" NOT NULL,
    "inputModalities" "AiModelModality"[] NOT NULL,
    "outputModalities" "AiModelModality"[] NOT NULL,
    "capabilities" "AiModelCapability"[] NOT NULL,
    "contextWindow" INTEGER,
    "maxOutputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModelCapabilityDefault_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiModelCapabilityDefault_modelId_key" ON "AiModelCapabilityDefault"("modelId");

-- CreateIndex
CREATE INDEX "AiModelCapabilityDefault_defaultsVersion_idx" ON "AiModelCapabilityDefault"("defaultsVersion");

-- CreateIndex
CREATE INDEX "AiModelCapabilityDefault_modelType_idx" ON "AiModelCapabilityDefault"("modelType");

-- BackfillData
UPDATE "ChatMessageGeneration" AS generation
SET "modelTargetSnapshot" = jsonb_strip_nulls(
  generation."modelTargetSnapshot" || jsonb_build_object(
    'modelName',
    COALESCE(
      generation."modelTargetSnapshot"->>'modelName',
      (
        SELECT model."modelName"
        FROM "AiProviderModel" AS model
        WHERE model."providerId" = generation."modelTargetSnapshot"->>'providerId'
          AND model."modelId" = generation."modelTargetSnapshot"->>'modelId'
        LIMIT 1
      ),
      generation."modelTargetSnapshot"->>'modelId',
      'unknown'
    ),
    'modelType',
    COALESCE(
      generation."modelTargetSnapshot"->>'modelType',
      (
        SELECT lower(model."modelType"::text)
        FROM "AiProviderModel" AS model
        WHERE model."providerId" = generation."modelTargetSnapshot"->>'providerId'
          AND model."modelId" = generation."modelTargetSnapshot"->>'modelId'
        LIMIT 1
      ),
      'chat'
    ),
    'inputModalities',
    COALESCE(
      NULLIF(generation."modelTargetSnapshot"->'inputModalities', 'null'::jsonb),
      (
        SELECT jsonb_agg(lower(modality::text))
        FROM "AiProviderModel" AS model,
          unnest(model."inputModalities") AS modality
        WHERE model."providerId" = generation."modelTargetSnapshot"->>'providerId'
          AND model."modelId" = generation."modelTargetSnapshot"->>'modelId'
      ),
      '["text"]'::jsonb
    ),
    'outputModalities',
    COALESCE(
      NULLIF(generation."modelTargetSnapshot"->'outputModalities', 'null'::jsonb),
      (
        SELECT jsonb_agg(lower(modality::text))
        FROM "AiProviderModel" AS model,
          unnest(model."outputModalities") AS modality
        WHERE model."providerId" = generation."modelTargetSnapshot"->>'providerId'
          AND model."modelId" = generation."modelTargetSnapshot"->>'modelId'
      ),
      '["text"]'::jsonb
    )
  )
)
WHERE jsonb_typeof(generation."modelTargetSnapshot") = 'object'
  AND (
    NOT (generation."modelTargetSnapshot" ? 'modelName')
    OR NOT (generation."modelTargetSnapshot" ? 'modelType')
    OR NOT (generation."modelTargetSnapshot" ? 'inputModalities')
    OR NOT (generation."modelTargetSnapshot" ? 'outputModalities')
  );
