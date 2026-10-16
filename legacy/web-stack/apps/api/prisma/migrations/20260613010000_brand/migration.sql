-- BackfillData
UPDATE "User"
SET "userCode" = 'LX-' || substring("userCode" FROM 4),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "userCode" LIKE 'SP-%';

UPDATE "AgentSkill"
SET "skillKey" = 'lexora.memory',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "skillKey" = 'samepage.memory'
  AND NOT EXISTS (
    SELECT 1
    FROM "AgentSkill" AS existing
    WHERE existing."skillKey" = 'lexora.memory'
  );

DELETE FROM "AgentSkill" AS old
WHERE old."skillKey" = 'samepage.memory'
  AND EXISTS (
    SELECT 1
    FROM "AgentSkill" AS existing
    WHERE existing."skillKey" = 'lexora.memory'
  );

UPDATE "AgentProfile"
SET "currentConfig" = jsonb_set(
      "currentConfig"::jsonb,
      '{instructions,systemPrompt}',
      to_jsonb('你是 Lexora 小助手。请根据用户问题、当前对话上下文和可用文档上下文，给出清晰、准确、可执行的回答。'::text),
      false
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "currentConfig"::jsonb #>> '{instructions,systemPrompt}' = '你是 SamePage 小助手。请根据用户问题、当前对话上下文和可用文档上下文，给出清晰、准确、可执行的回答。';

UPDATE "AgentProfile"
SET "currentConfig" = jsonb_set(
      "currentConfig"::jsonb,
      '{skillBindings}',
      (
        SELECT jsonb_agg(
          CASE
            WHEN binding.value->>'key' = 'samepage.memory'
              THEN jsonb_set(binding.value, '{key}', to_jsonb('lexora.memory'::text), false)
            ELSE binding.value
          END
          ORDER BY binding.ordinality
        )
        FROM jsonb_array_elements("currentConfig"::jsonb->'skillBindings') WITH ORDINALITY AS binding(value, ordinality)
      ),
      false
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE jsonb_typeof("currentConfig"::jsonb) = 'object'
  AND jsonb_typeof("currentConfig"::jsonb->'skillBindings') = 'array'
  AND "currentConfig"::jsonb->'skillBindings' @> '[{"key":"samepage.memory"}]'::jsonb;

UPDATE "DocumentPublicationSite"
SET "title" = 'Lexora Docs',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "title" = 'SamePage Docs';

UPDATE "DocumentPublicationSite"
SET "homeConfig" = jsonb_set(
      "homeConfig"::jsonb,
      '{hero,name}',
      to_jsonb('Lexora'::text),
      false
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE jsonb_typeof("homeConfig"::jsonb) = 'object'
  AND "homeConfig"::jsonb #>> '{hero,name}' = 'SamePage';
