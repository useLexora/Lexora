export const BUDDY_V30_TASK_MODELS_SCHEMA_SQL = `
CREATE TABLE conversation_members_v30 (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  actor_id TEXT NOT NULL REFERENCES buddies(id),
  model_selection_json TEXT CHECK (model_selection_json IS NULL OR json_valid(model_selection_json)),
  model_selection_source TEXT CHECK (model_selection_source IS NULL OR model_selection_source IN ('legacy', 'explicit', 'snapshot')),
  joined_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (conversation_id, actor_id),
  CHECK ((model_selection_json IS NULL AND model_selection_source IS NULL) OR (model_selection_json IS NOT NULL AND model_selection_source IS NOT NULL))
);
INSERT INTO conversation_members_v30 SELECT * FROM conversation_members;
DROP TABLE conversation_members;
ALTER TABLE conversation_members_v30 RENAME TO conversation_members;

WITH latest_models AS (
  SELECT runs.conversation_id, runs.buddy_id,
    COALESCE(runs.model_override_json, json_extract(runs.actor_snapshot_json, '$.model'),
      json_object('providerId', runs.provider, 'modelId', runs.model,
        'reasoning', run_inputs.reasoning, 'serviceTier', run_inputs.service_tier)) AS selection,
    ROW_NUMBER() OVER (PARTITION BY runs.conversation_id, runs.buddy_id ORDER BY runs.started_at DESC, runs.rowid DESC) AS position
  FROM runs LEFT JOIN run_inputs ON run_inputs.run_id = runs.id
  WHERE runs.purpose = 'chat' AND runs.execution_kind IN ('root', 'actor_child')
)
UPDATE conversation_members
SET model_selection_json = latest_models.selection, model_selection_source = 'snapshot'
FROM latest_models
WHERE latest_models.position = 1
  AND conversation_members.conversation_id = latest_models.conversation_id
  AND conversation_members.actor_id = latest_models.buddy_id
  AND conversation_members.model_selection_json IS NULL;
`
