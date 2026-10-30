import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { BUDDY_V37_MODEL_TYPES_SCHEMA_SQL } from '../migrations/v37ModelTypes'
import { BUDDY_V38_IMAGE_MODELS_SCHEMA_SQL } from '../migrations/v38ImageModels'

it('preserves existing model types, overrides and disabled state when enabling image models', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(BUDDY_V37_MODEL_TYPES_SCHEMA_SQL.split('INSERT INTO')[0]!.replace('provider_model_states_next', 'provider_model_states'))
    const insert = db.prepare(`INSERT INTO provider_model_states (provider_id, model_id, display_name, api, input_json, reasoning, cost_json, source, enabled, available, created_at, updated_at, model_type, type_override) VALUES ('service', ?, 'Name', 'openai-audio', '["text"]', 0, '{}', 'manual', 0, 1, 'created', 'updated', ?, ?)`)
    insert.run('speech', 'speech', 'transcription')
    insert.run('transcribe', 'transcription', null)
    const before = db.prepare('SELECT * FROM provider_model_states ORDER BY model_id').all()
    db.exec(BUDDY_V38_IMAGE_MODELS_SCHEMA_SQL)
    expect(db.prepare('SELECT * FROM provider_model_states ORDER BY model_id').all()).toEqual(before)
    db.prepare(`INSERT INTO provider_model_states SELECT provider_id, 'image', display_name, api, input_json, reasoning, cost_json, context_window, max_tokens, override_context_window, override_max_tokens, source_revision, acknowledged_source_revision, source, enabled, available, last_seen_at, created_at, updated_at, thinking_level_map_json, sampling_params_json, compat_json, catalog_provider_id, source_fingerprint, catalog_model_id, catalog_selection_json, capability_overrides_json, service_metadata_json, 'image-generation', NULL FROM provider_model_states WHERE model_id='speech'`).run()
    expect(db.prepare('SELECT model_type FROM provider_model_states WHERE model_id=\'image\'').get()).toEqual({ model_type: 'image-generation' })
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  }
  finally { db.close() }
})
