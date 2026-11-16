import type { DatabaseSync } from 'node:sqlite'

export interface ProviderConfigRecord {
  authentication?: 'api_key' | 'none'
  id: string
  displayName: string
  description: string | null
  api: string
  baseUrl: string
  models: unknown[]
  credentialRef: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ProviderConfigRepository {
  findById: (id: string) => ProviderConfigRecord | null
  list: () => ProviderConfigRecord[]
  remove: (id: string) => boolean
  upsert: (record: ProviderConfigRecord) => ProviderConfigRecord
}

interface ProviderConfigRow {
  authentication: 'api_key' | 'none'
  id: string
  display_name: string
  description: string | null
  api: string
  base_url: string
  models_json: string
  credential_ref: string | null
  enabled: number
  created_at: string
  updated_at: string
}

export function createProviderConfigRepository(
  database: DatabaseSync,
): ProviderConfigRepository {
  const find = database.prepare('SELECT * FROM provider_configs WHERE id = ?')
  const list = database.prepare('SELECT * FROM provider_configs ORDER BY display_name, id')
  const remove = database.prepare('DELETE FROM provider_configs WHERE id = ?')
  const upsert = database.prepare(`
    INSERT INTO provider_configs (
      id, display_name, description, api, base_url, models_json,
      credential_ref, enabled, created_at, updated_at, authentication
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      display_name = excluded.display_name,
      description = excluded.description,
      api = excluded.api,
      base_url = excluded.base_url,
      models_json = excluded.models_json,
      credential_ref = excluded.credential_ref,
      authentication = excluded.authentication,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `)

  return {
    findById(id) {
      const row = find.get(id) as ProviderConfigRow | undefined
      return row ? toProviderConfig(row) : null
    },
    list() {
      return (list.all() as unknown as ProviderConfigRow[]).map(toProviderConfig)
    },
    remove(id) {
      return Number(remove.run(id).changes) === 1
    },
    upsert(record) {
      upsert.run(
        record.id,
        record.displayName,
        record.description,
        record.api,
        record.baseUrl,
        JSON.stringify(record.models),
        record.credentialRef,
        Number(record.enabled),
        record.createdAt,
        record.updatedAt,
        record.authentication ?? 'api_key',
      )
      return requireProviderConfig(find.get(record.id), record.id)
    },
  }
}

function requireProviderConfig(value: unknown, id: string): ProviderConfigRecord {
  const row = value as ProviderConfigRow | undefined
  if (!row)
    throw new Error(`Lexora Buddy provider was not persisted: ${id}`)
  return toProviderConfig(row)
}

function toProviderConfig(row: ProviderConfigRow): ProviderConfigRecord {
  const models: unknown = JSON.parse(row.models_json)
  if (!Array.isArray(models))
    throw new Error(`Lexora Buddy provider models are invalid: ${row.id}`)

  return {
    authentication: row.authentication,
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    api: row.api,
    baseUrl: row.base_url,
    models,
    credentialRef: row.credential_ref,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
