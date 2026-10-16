-- BackfillData
WITH personal_workspace_owner AS (
  SELECT
    workspace."id" AS "workspaceId",
    owner."userCode"
  FROM "Workspace" AS workspace
  INNER JOIN "WorkspaceMember" AS member
    ON member."workspaceId" = workspace."id"
  INNER JOIN "User" AS owner
    ON owner."id" = member."userId"
  WHERE workspace."type" = 'PERSONAL'
    AND member."role" = 'OWNER'
    AND member."status" = 'ACTIVE'
    AND owner."userCode" LIKE 'LX-%'
)
UPDATE "Workspace" AS workspace
SET "name" = CASE
      WHEN workspace."name" = 'Personal SP-' || substring(personal_workspace_owner."userCode" FROM 4)
        THEN 'Personal ' || personal_workspace_owner."userCode"
      ELSE workspace."name"
    END,
    "slug" = CASE
      WHEN workspace."slug" = 'personal-sp-' || lower(substring(personal_workspace_owner."userCode" FROM 4))
        THEN 'personal-' || lower(personal_workspace_owner."userCode")
      ELSE workspace."slug"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM personal_workspace_owner
WHERE workspace."id" = personal_workspace_owner."workspaceId"
  AND (
    workspace."name" = 'Personal SP-' || substring(personal_workspace_owner."userCode" FROM 4)
    OR workspace."slug" = 'personal-sp-' || lower(substring(personal_workspace_owner."userCode" FROM 4))
  );

UPDATE "SystemEmailConfig"
SET "fromName" = 'Lexora',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "fromName" = 'SamePage';

UPDATE "AgentProfile" AS profile
SET "currentConfig" = jsonb_set(
      profile."currentConfig"::jsonb,
      '{skillBindings}',
      (
        SELECT COALESCE(jsonb_agg(binding.value ORDER BY binding.ordinality), '[]'::jsonb)
        FROM jsonb_array_elements(profile."currentConfig"::jsonb->'skillBindings') WITH ORDINALITY AS binding(value, ordinality)
        WHERE NOT (
          binding.value->>'key' = 'lexora.memory'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(profile."currentConfig"::jsonb->'skillBindings') WITH ORDINALITY AS previous_binding(value, ordinality)
            WHERE previous_binding.value->>'key' = 'lexora.memory'
              AND previous_binding.ordinality < binding.ordinality
          )
        )
      ),
      false
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE jsonb_typeof(profile."currentConfig"::jsonb) = 'object'
  AND jsonb_typeof(profile."currentConfig"::jsonb->'skillBindings') = 'array'
  AND (
    SELECT count(*)
    FROM jsonb_array_elements(profile."currentConfig"::jsonb->'skillBindings') AS binding(value)
    WHERE binding.value->>'key' = 'lexora.memory'
  ) > 1;
