import type { Api, Model } from '@earendil-works/pi-ai'
import type { ServiceModelMetadata } from '../../../shared/providers/providerDiscovery'
import type { ProviderModelType } from '../../../shared/providers/providerModelType'
import type { ProviderModelStateRecord } from '../storage/providerModelStateRepository'
import type { CatalogModel } from './ModelsDevCatalog'
import { createHash } from 'node:crypto'
import { BUDDY_THINKING_LEVELS } from '../../../shared/conversation/modelSelection'
import { serializeModelMetadata } from './modelMetadata'

export function nextSourceRevision(previous: string | undefined, candidate: string): string {
  if (!previous || candidate > previous)
    return candidate
  return new Date(Date.parse(previous) + 1).toISOString()
}

export interface ModelSourceMetadata {
  type: ProviderModelType
  serviceMetadata: ServiceModelMetadata | null
  api: string
  catalogProviderId: string | null
  catalogModelId: string | null
  compat: Model<Api>['compat'] | null
  cost: Model<Api>['cost']
  displayName: string
  input: Array<'text' | 'image'>
  reasoning: boolean
  samplingParams: Record<string, unknown> | null
  sourceContextWindow: number | null
  sourceFingerprint: string
  sourceMaxTokens: number | null
  thinkingLevelMap: Model<Api>['thinkingLevelMap'] | null
}

export function sourceMetadataFromCatalogModel(api: string, model: CatalogModel, cost: Model<Api>['cost'], current: ProviderModelStateRecord | null = null, serviceMetadata: ServiceModelMetadata | null = null): ModelSourceMetadata {
  return createSourceMetadata({
    api,
    catalogProviderId: model.provider,
    catalogModelId: model.id,
    compat: current?.api === api ? current.compat : null,
    cost,
    displayName: model.name,
    input: [...model.input],
    reasoning: model.reasoning,
    samplingParams: current?.api === api ? current.samplingParams : null,
    sourceContextWindow: model.contextWindow,
    sourceMaxTokens: model.maxTokens,
    thinkingLevelMap: model.thinkingLevelMap ?? null,
  }, serviceMetadata)
}

export function emptyModelCost(): Model<Api>['cost'] {
  return { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
}

export function createSourceMetadata(
  input: Omit<ModelSourceMetadata, 'type' | 'sourceFingerprint' | 'catalogModelId' | 'serviceMetadata'> & { type?: ProviderModelType, catalogModelId?: string | null },
  serviceMetadata: ServiceModelMetadata | null = null,
): ModelSourceMetadata {
  const declared = serviceMetadata?.metadata
  const reasoningOptions = declared?.reasoningOptions
  const contextWindow = declared?.contextWindow ?? input.sourceContextWindow
  const maxTokens = declared?.maxTokens ?? input.sourceMaxTokens
  const metadata = {
    ...input,
    type: input.type ?? 'chat' as const,
    catalogModelId: input.catalogModelId ?? null,
    serviceMetadata,
    ...(declared && (input.type ?? 'chat') === 'chat'
      ? {
          displayName: declared.name ?? input.displayName,
          input: declared.input ? declared.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image') : input.input,
          reasoning: reasoningOptions !== undefined ? reasoningOptions.some(level => level !== 'off') : input.reasoning,
          thinkingLevelMap: reasoningOptions !== undefined
            ? Object.fromEntries(BUDDY_THINKING_LEVELS.map(level => [level, reasoningOptions.includes(level) ? level === 'off' ? 'none' : level : null]))
            : input.thinkingLevelMap,
          sourceContextWindow: declared.contextWindow === undefined ? Math.max(contextWindow ?? 128_000, maxTokens ?? 16_384) : contextWindow,
          sourceMaxTokens: declared.maxTokens === undefined ? Math.min(maxTokens ?? 16_384, contextWindow ?? 128_000) : maxTokens,
        }
      : {}),
  }
  return {
    ...metadata,
    sourceFingerprint: createHash('sha256')
      .update(serializeModelMetadata(metadata))
      .digest('hex'),
  }
}

export function sourceParametersChanged(
  current: ProviderModelStateRecord | null,
  next: ModelSourceMetadata,
): boolean {
  return !current
    || current.sourceContextWindow !== next.sourceContextWindow
    || current.sourceMaxTokens !== next.sourceMaxTokens
}
