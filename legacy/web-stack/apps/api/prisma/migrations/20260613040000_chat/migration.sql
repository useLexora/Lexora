WITH latest_generation_model AS (
  SELECT DISTINCT ON ("sessionId")
    "sessionId",
    "modelTargetSnapshot"->>'providerId' AS "providerId",
    "modelTargetSnapshot"->>'modelId' AS "modelId"
  FROM "ChatMessageGeneration"
  WHERE "deletedAt" IS NULL
    AND "modelTargetSnapshot" IS NOT NULL
    AND "modelTargetSnapshot"->>'providerId' IS NOT NULL
    AND "modelTargetSnapshot"->>'modelId' IS NOT NULL
  ORDER BY "sessionId", "createdAt" DESC
)
UPDATE "ChatSession" AS session
SET
  "modelOverrideProviderId" = latest."providerId",
  "modelOverrideModelId" = latest."modelId",
  "updatedAt" = NOW()
FROM latest_generation_model AS latest
WHERE session."id" = latest."sessionId"
  AND (
    session."modelOverrideProviderId" IS NULL
    OR session."modelOverrideModelId" IS NULL
  );
