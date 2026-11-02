import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { BUDDY_V38_IMAGE_MODELS_SCHEMA_SQL } from '../migrations/v38ImageModels'
import { BUDDY_V39_PROVIDER_RESOLUTION_SCHEMA_SQL } from '../migrations/v39ProviderResolution'
import { createProviderResolutionRepository } from '../providerResolutionRepository'

function fixture() {
  const database = new DatabaseSync(':memory:')
  database.exec(BUDDY_V38_IMAGE_MODELS_SCHEMA_SQL.split('INSERT INTO')[0]!.replace('provider_model_states_next', 'provider_model_states'))
  database.exec(`INSERT INTO provider_model_states (provider_id, model_id, display_name, api, input_json, reasoning, cost_json, context_window, max_tokens, override_context_window, override_max_tokens, source_revision, source_fingerprint, source, enabled, available, created_at, updated_at) VALUES ('service', 'model', 'Model', 'openai-completions', '["text"]', 0, '{}', 32000, 4096, 16000, 2048, 'source-revision', 'source-fingerprint', 'synced', 0, 1, 'created', 'updated')`)
  return database
}

describe('provider resolution checkpoint migration and commits', () => {
  it('adds nullable resolution without changing existing source data, overrides or timestamps', () => {
    const database = fixture()
    try {
      const before = database.prepare('SELECT * FROM provider_model_states').get()
      database.exec(BUDDY_V39_PROVIDER_RESOLUTION_SCHEMA_SQL)
      expect(database.prepare('SELECT * FROM provider_model_states').get()).toEqual({ ...before, resolution_json: null })
      expect(database.prepare('SELECT * FROM provider_resolution_checkpoints').all()).toEqual([])
      expect(() => database.exec(`UPDATE provider_model_states SET resolution_json = 'invalid-json'`)).toThrow()
      expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    }
    finally { database.close() }
  })

  it('commits source changes with their checkpoint atomically and invalidates only changed parsing inputs', () => {
    const database = fixture()
    try {
      database.exec(BUDDY_V39_PROVIDER_RESOLUTION_SCHEMA_SQL)
      const repository = createProviderResolutionRepository(database)
      repository.commit('service', 'first-input', () => {})
      database.exec('UPDATE provider_model_states SET enabled = 1, override_context_window = 24000')
      expect(repository.find('service')).toBe('first-input')
      expect(() => repository.commit('service', 'uncommitted-input', () => {
        database.exec(`UPDATE provider_model_states SET context_window = 64000, source_revision = 'new-revision'`)
        throw new Error('failed-model-commit')
      })).toThrow('failed-model-commit')
      expect(repository.find('service')).toBe('first-input')
      expect(database.prepare('SELECT context_window, source_revision FROM provider_model_states').get()).toEqual({ context_window: 32000, source_revision: 'source-revision' })
      repository.commit('service', 'second-input', () => database.exec(`UPDATE provider_model_states SET catalog_selection_json = '{"providerId":"chosen","modelId":"model"}'`))
      expect(repository.find('service')).toBe('second-input')
      database.exec(`UPDATE provider_model_states SET service_metadata_json = '{}'`)
      expect(repository.find('service')).toBeNull()
      repository.commit('service', 'third-input', () => {})
      database.exec('DELETE FROM provider_model_states')
      expect(repository.find('service')).toBeNull()
    }
    finally { database.close() }
  })
})
