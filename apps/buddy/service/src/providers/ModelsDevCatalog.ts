import type { Api, Model } from '@earendil-works/pi-ai'
import { BUDDY_THINKING_LEVELS } from '../../../shared/conversation/modelSelection'
import { freezeEventSnapshot } from '../../../shared/events/eventSnapshot'

export interface CatalogModel {
  id: string
  provider: string
  name: string
  baseUrl: string
  input: Model<Api>['input']
  pdfInput?: boolean
  audioInput?: boolean
  videoInput?: boolean
  toolCall?: boolean
  fastMode?: boolean
  reasoning: boolean
  thinkingLevelMap?: Model<Api>['thinkingLevelMap']
  contextWindow: number
  maxTokens: number
  cost: Model<Api>['cost']
}

export interface ModelMetadataCatalog {
  getModels: (providerId?: string) => readonly CatalogModel[]
  getProviders: () => ReadonlyArray<{ id: string, name: string }>
}

const SDK_BASE_URLS: Record<string, string> = {
  '@ai-sdk/openai': 'https://api.openai.com/v1',
  '@ai-sdk/anthropic': 'https://api.anthropic.com',
  '@ai-sdk/google': 'https://generativelanguage.googleapis.com/v1beta',
}

export class ModelsDevCatalog implements ModelMetadataCatalog {
  readonly #providers: Array<{ id: string, name: string }> = []
  readonly #models: CatalogModel[] = []
  readonly #byProvider = new Map<string, CatalogModel[]>()

  constructor(data: unknown) {
    if (!isRecord(data))
      throw new Error('Invalid models.dev catalog')
    for (const [providerId, provider] of Object.entries(data)) {
      if (!isRecord(provider) || !isRecord(provider.models) || typeof provider.name !== 'string')
        throw new Error('Invalid models.dev provider')
      const models: CatalogModel[] = []
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (!isRecord(model) || !isRecord(model.modalities) || !Array.isArray(model.modalities.input)
          || !Array.isArray(model.modalities.output) || !isRecord(model.limit)) {
          throw new Error('Invalid models.dev model')
        }
        if (!model.modalities.input.includes('text') || !model.modalities.output.includes('text'))
          continue
        if (typeof model.name !== 'string')
          throw new Error('Invalid models.dev model name')
        if (!positiveInteger(model.limit.context) || !positiveInteger(model.limit.output))
          continue
        const cost = isRecord(model.cost) ? model.cost : {}
        models.push({
          id: modelId,
          provider: providerId,
          name: model.name,
          baseUrl: typeof provider.api === 'string' ? provider.api : SDK_BASE_URLS[String(provider.npm)] ?? '',
          input: model.modalities.input.includes('image') ? ['text', 'image'] : ['text'],
          pdfInput: model.modalities.input.includes('pdf'),
          audioInput: model.modalities.input.includes('audio'),
          videoInput: model.modalities.input.includes('video'),
          toolCall: typeof model.tool_call === 'boolean' ? model.tool_call : undefined,
          fastMode: supportsFastMode(model),
          reasoning: model.reasoning === true,
          thinkingLevelMap: reasoningMap(model),
          contextWindow: model.limit.context,
          maxTokens: model.limit.output,
          cost: modelCost(cost),
        })
      }
      if (models.length) {
        this.#providers.push({ id: providerId, name: provider.name })
        this.#models.push(...models)
        this.#byProvider.set(providerId, models)
      }
    }
    if (!this.#models.length)
      throw new Error('Empty models.dev catalog')
    freezeEventSnapshot(this.#providers)
    freezeEventSnapshot(this.#models)
    for (const models of this.#byProvider.values()) freezeEventSnapshot(models)
  }

  getProviders() {
    return this.#providers as ReadonlyArray<{ id: string, name: string }>
  }

  getModels(providerId?: string): readonly CatalogModel[] {
    return providerId ? this.#byProvider.get(providerId) ?? [] : this.#models
  }
}

function supportsFastMode(model: Record<string, unknown>): boolean {
  const modes = isRecord(model.experimental) ? model.experimental.modes : undefined
  const fast = isRecord(modes) ? modes.fast : undefined
  const provider = isRecord(fast) ? fast.provider : undefined
  const body = isRecord(provider) ? provider.body : undefined
  return isRecord(body) && (body.service_tier === 'priority' || body.service_tier === 'fast')
}

function reasoningMap(model: Record<string, unknown>): Model<Api>['thinkingLevelMap'] {
  if (model.reasoning !== true)
    return undefined
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options.filter(isRecord) : []
  const efforts = options.filter(option => option.type === 'effort')
    .flatMap(option => Array.isArray(option.values) ? option.values : [])
    .filter((value): value is string => typeof value === 'string')
  if (!efforts.length)
    return undefined
  const levels = new Map<string, string | undefined>(efforts.map(value => [value === 'none' ? 'off' : value, value]))
  if (options.some(option => option.type === 'toggle') && !levels.has('off'))
    levels.set('off', undefined)
  return Object.fromEntries(BUDDY_THINKING_LEVELS.map(level => [level, levels.has(level) ? levels.get(level) : null]))
}

function modelCost(cost: Record<string, unknown>): Model<Api>['cost'] {
  const rates = costRates(cost)
  const tiers = (Array.isArray(cost.tiers) ? cost.tiers : []).filter(isRecord).flatMap((entry) => {
    if (!isRecord(entry.tier) || entry.tier.type !== 'context' || !positiveInteger(entry.tier.size))
      return []
    return [{ ...costRates(entry, rates), inputTokensAbove: entry.tier.size }]
  })
  return tiers.length ? { ...rates, tiers } : rates
}

function costRates(cost: Record<string, unknown>, fallback?: Model<Api>['cost']): Model<Api>['cost'] {
  return {
    input: price(cost.input ?? fallback?.input),
    output: price(cost.output ?? fallback?.output),
    cacheRead: price(cost.cache_read ?? fallback?.cacheRead),
    cacheWrite: price(cost.cache_write ?? fallback?.cacheWrite),
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function price(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
