import type { ProviderModelStateRecord } from '../storage/providerModelStateRepository'
import type { ModelSourceMetadata } from './providerModelSource'
import { nextSourceRevision, sourceParametersChanged } from './providerModelSource'

export type ModelReconciliationPolicy = 'plugin-chat' | 'plugin-capability' | 'builtin' | 'builtin-metadata' | 'catalog-media' | 'synced-complete' | 'synced-partial'

export interface ObservedProviderModel {
  providerId: string
  modelId: string
  metadata: ModelSourceMetadata
  available?: boolean
}

export function planModelReconciliation(
  currentModels: readonly ProviderModelStateRecord[],
  observations: readonly ObservedProviderModel[],
  policy: ModelReconciliationPolicy,
  now: string,
): { upserts: ProviderModelStateRecord[], unavailable: ProviderModelStateRecord[] } {
  const currentById = new Map(currentModels.map(model => [identity(model), model]))
  const seen = new Set(observations.map(identity))
  const plugin = policy === 'plugin-chat' || policy === 'plugin-capability'
  const metadataOnly = policy === 'builtin-metadata'
  const synced = policy === 'synced-complete' || policy === 'synced-partial'
  const upserts: ProviderModelStateRecord[] = []
  for (const observation of observations) {
    const current = currentById.get(identity(observation)) ?? null
    if ((!plugin && current?.source === 'manual') || (metadataOnly && !current))
      continue
    const metadata = observation.metadata
    const preserveRevision = policy === 'catalog-media' || policy === 'plugin-capability'
    const next: ProviderModelStateRecord = {
      ...metadata,
      providerId: observation.providerId,
      modelId: observation.modelId,
      source: plugin || synced ? 'synced' : 'builtin',
      typeOverride: plugin ? null : current?.typeOverride ?? null,
      catalogSelection: synced ? current?.catalogSelection ?? null : null,
      capabilityOverrides: current?.capabilityOverrides ?? null,
      acknowledgedSourceRevision: policy === 'plugin-capability' ? null : current?.acknowledgedSourceRevision ?? null,
      overrideContextWindow: plugin ? null : current?.overrideContextWindow ?? null,
      overrideMaxTokens: plugin ? null : current?.overrideMaxTokens ?? null,
      enabled: current?.enabled ?? plugin,
      available: metadataOnly ? current!.available : observation.available ?? true,
      createdAt: current?.createdAt ?? now,
      lastSeenAt: metadataOnly ? current!.lastSeenAt : now,
      updatedAt: now,
      sourceRevision: !preserveRevision && sourceParametersChanged(current, metadata)
        ? nextSourceRevision(current?.sourceRevision, now)
        : current?.sourceRevision ?? now,
      ...(policy === 'catalog-media'
        ? {
            sourceContextWindow: current?.typeOverride === 'chat' ? current.sourceContextWindow : null,
            sourceMaxTokens: current?.typeOverride === 'chat' ? current.sourceMaxTokens : null,
          }
        : {}),
    }
    upserts.push(next)
    currentById.set(identity(next), next)
  }
  const unavailable = currentModels.filter(current => !seen.has(identity(current)) && marksMissingUnavailable(current, policy))
    .map(current => ({ ...current, available: false, updatedAt: now }))
  return { upserts, unavailable }
}

function marksMissingUnavailable(current: ProviderModelStateRecord, policy: ModelReconciliationPolicy): boolean {
  switch (policy) {
    case 'builtin-metadata':
    case 'synced-partial':
      return false
    case 'plugin-chat':
      return (current.typeOverride ?? current.type ?? 'chat') === 'chat'
    case 'plugin-capability':
      return current.api === 'plugin-speech' || current.api === 'plugin-image'
    case 'builtin':
      return current.source !== 'manual' && (current.typeOverride ?? current.type ?? 'chat') === 'chat' && current.available
    case 'catalog-media':
      return current.source === 'builtin' && current.api === 'openai-audio' && current.available
    case 'synced-complete':
      return current.source === 'synced'
  }
}

function identity(model: { providerId: string, modelId: string }): string {
  return JSON.stringify([model.providerId, model.modelId])
}
