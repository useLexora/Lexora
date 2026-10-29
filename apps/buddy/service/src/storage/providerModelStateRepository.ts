import type { Api, Model } from '@earendil-works/pi-ai'
import type { DatabaseSync } from 'node:sqlite'
import type { ModelCapabilityOverrides } from '../../../shared/providers/providerCapabilities'
import type { ModelCatalogReference } from '../../../shared/providers/providerCatalog'
import type { ServiceModelMetadata } from '../../../shared/providers/providerDiscovery'
import type { ProviderModelType } from '../../../shared/providers/providerModelType'
import { modelCapabilityOverridesSchema } from '../../../shared/providers/providerCapabilities'
import { modelCatalogReferenceSchema } from '../../../shared/providers/providerCatalog'
import { serviceModelMetadataSchema } from '../../../shared/providers/providerDiscovery'

export type ProviderModelSource = 'builtin' | 'manual' | 'synced'

export interface ProviderModelStateRecord {
  type?: ProviderModelType
  typeOverride?: ProviderModelType | null
  providerId: string
  modelId: string
  displayName: string
  api: string
  catalogProviderId: string | null
  catalogModelId: string | null
  serviceMetadata?: ServiceModelMetadata | null
  catalogSelection: ModelCatalogReference | null
  capabilityOverrides: ModelCapabilityOverrides | null
  compat: Model<Api>['compat'] | null
  input: Array<'text' | 'image'>
  reasoning: boolean
  cost: Model<Api>['cost']
  samplingParams: Record<string, unknown> | null
  sourceContextWindow: number | null
  sourceMaxTokens: number | null
  overrideContextWindow: number | null
  overrideMaxTokens: number | null
  sourceRevision: string
  sourceFingerprint: string
  thinkingLevelMap: Model<Api>['thinkingLevelMap'] | null
  acknowledgedSourceRevision: string | null
  source: ProviderModelSource
  enabled: boolean
  available: boolean
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ProviderModelStateRepository {
  find: (providerId: string, modelId: string) => ProviderModelStateRecord | null
  list: (providerId?: string) => ProviderModelStateRecord[]
  remove: (providerId: string, modelId: string) => boolean
  removeForProvider: (providerId: string) => number
  upsert: (record: ProviderModelStateRecord) => ProviderModelStateRecord
}

interface ProviderModelStateRow {
  model_type: ProviderModelType
  type_override: ProviderModelType | null
  provider_id: string
  model_id: string
  display_name: string
  api: string
  catalog_provider_id: string | null
  catalog_model_id: string | null
  service_metadata_json: string | null
  catalog_selection_json: string | null
  capability_overrides_json: string | null
  compat_json: string | null
  input_json: string
  reasoning: number
  cost_json: string
  sampling_params_json: string | null
  context_window: number | null
  max_tokens: number | null
  override_context_window: number | null
  override_max_tokens: number | null
  source_revision: string
  source_fingerprint: string
  thinking_level_map_json: string | null
  acknowledged_source_revision: string | null
  source: ProviderModelSource
  enabled: number
  available: number
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export function createProviderModelStateRepository(
  database: DatabaseSync,
): ProviderModelStateRepository {
  const find = database.prepare(`
    SELECT * FROM provider_model_states WHERE provider_id = ? AND model_id = ?
  `)
  const listAll = database.prepare(`
    SELECT * FROM provider_model_states ORDER BY provider_id, display_name, model_id
  `)
  const listForProvider = database.prepare(`
    SELECT * FROM provider_model_states
    WHERE provider_id = ?
    ORDER BY display_name, model_id
  `)
  const remove = database.prepare(`
    DELETE FROM provider_model_states WHERE provider_id = ? AND model_id = ?
  `)
  const removeForProvider = database.prepare(`
    DELETE FROM provider_model_states WHERE provider_id = ?
  `)
  const upsert = database.prepare(`
    INSERT INTO provider_model_states (
      provider_id, model_id, display_name, api, input_json, reasoning, cost_json,
      context_window, max_tokens, override_context_window, override_max_tokens,
      source_revision, acknowledged_source_revision, source, enabled, available,
      last_seen_at, created_at, updated_at, thinking_level_map_json,
      sampling_params_json, compat_json, catalog_provider_id, source_fingerprint,
      catalog_model_id, catalog_selection_json, capability_overrides_json, service_metadata_json, model_type, type_override
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider_id, model_id) DO UPDATE SET
      model_type = excluded.model_type,
      type_override = excluded.type_override,
      display_name = excluded.display_name,
      api = excluded.api,
      input_json = excluded.input_json,
      reasoning = excluded.reasoning,
      cost_json = excluded.cost_json,
      context_window = excluded.context_window,
      max_tokens = excluded.max_tokens,
      override_context_window = excluded.override_context_window,
      override_max_tokens = excluded.override_max_tokens,
      source_revision = excluded.source_revision,
      acknowledged_source_revision = excluded.acknowledged_source_revision,
      source = excluded.source,
      enabled = excluded.enabled,
      available = excluded.available,
      last_seen_at = excluded.last_seen_at,
      thinking_level_map_json = excluded.thinking_level_map_json,
      sampling_params_json = excluded.sampling_params_json,
      compat_json = excluded.compat_json,
      catalog_provider_id = excluded.catalog_provider_id,
      catalog_model_id = excluded.catalog_model_id,
      catalog_selection_json = excluded.catalog_selection_json,
      capability_overrides_json = excluded.capability_overrides_json,
      service_metadata_json = excluded.service_metadata_json,
      source_fingerprint = excluded.source_fingerprint,
      updated_at = excluded.updated_at
  `)

  return {
    find(providerId, modelId) {
      const row = find.get(providerId, modelId) as ProviderModelStateRow | undefined
      return row ? toProviderModelState(row) : null
    },
    list(providerId) {
      const rows = providerId ? listForProvider.all(providerId) : listAll.all()
      return (rows as unknown as ProviderModelStateRow[]).map(toProviderModelState)
    },
    remove(providerId, modelId) {
      return Number(remove.run(providerId, modelId).changes) === 1
    },
    removeForProvider(providerId) {
      return Number(removeForProvider.run(providerId).changes)
    },
    upsert(record) {
      upsert.run(
        record.providerId,
        record.modelId,
        record.displayName,
        record.api,
        JSON.stringify(record.input),
        Number(record.reasoning),
        JSON.stringify(record.cost),
        record.sourceContextWindow,
        record.sourceMaxTokens,
        record.overrideContextWindow,
        record.overrideMaxTokens,
        record.sourceRevision,
        record.acknowledgedSourceRevision,
        record.source,
        Number(record.enabled),
        Number(record.available),
        record.lastSeenAt,
        record.createdAt,
        record.updatedAt,
        serializeJson(record.thinkingLevelMap),
        serializeJson(record.samplingParams),
        serializeJson(record.compat),
        record.catalogProviderId,
        record.sourceFingerprint,
        record.catalogModelId,
        serializeJson(record.catalogSelection),
        serializeJson(record.capabilityOverrides),
        serializeJson(record.serviceMetadata),
        record.type ?? 'chat',
        record.typeOverride ?? null,
      )
      return requireProviderModelState(find.get(record.providerId, record.modelId))
    },
  }
}

function requireProviderModelState(value: unknown): ProviderModelStateRecord {
  const row = value as ProviderModelStateRow | undefined
  if (!row)
    throw new Error('Lexora Buddy provider model state was not persisted')
  return toProviderModelState(row)
}

function toProviderModelState(row: ProviderModelStateRow): ProviderModelStateRecord {
  return {
    type: row.model_type,
    typeOverride: row.type_override,
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    api: row.api,
    catalogProviderId: row.catalog_provider_id,
    catalogModelId: row.catalog_model_id,
    serviceMetadata: row.service_metadata_json ? serviceModelMetadataSchema.parse(JSON.parse(row.service_metadata_json)) : null,
    catalogSelection: row.catalog_selection_json
      ? modelCatalogReferenceSchema.parse(JSON.parse(row.catalog_selection_json))
      : null,
    capabilityOverrides: row.capability_overrides_json
      ? modelCapabilityOverridesSchema.parse(JSON.parse(row.capability_overrides_json))
      : null,
    compat: parseJsonObject(row.compat_json) as Model<Api>['compat'] | null,
    input: JSON.parse(row.input_json) as Array<'text' | 'image'>,
    reasoning: row.reasoning === 1,
    cost: JSON.parse(row.cost_json) as ProviderModelStateRecord['cost'],
    samplingParams: parseJsonObject(row.sampling_params_json),
    sourceContextWindow: row.context_window,
    sourceMaxTokens: row.max_tokens,
    overrideContextWindow: row.override_context_window,
    overrideMaxTokens: row.override_max_tokens,
    sourceRevision: row.source_revision,
    sourceFingerprint: row.source_fingerprint,
    thinkingLevelMap: parseJsonObject(row.thinking_level_map_json) as Model<Api>['thinkingLevelMap'] | null,
    acknowledgedSourceRevision: row.acknowledged_source_revision,
    source: row.source,
    enabled: row.enabled === 1,
    available: row.available === 1,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null)
    return null
  const parsed: unknown = JSON.parse(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null
}

function serializeJson(value: object | null | undefined): string | null {
  return value ? JSON.stringify(value) : null
}
