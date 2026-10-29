import type { Api, Model } from '@earendil-works/pi-ai'
import type { ProviderModelType } from '../../../shared/providers/providerModelType'
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

export interface CatalogMediaModel {
  type?: ProviderModelType
  baseUrl?: string
  api?: 'openai-audio'
  protocols?: readonly string[]
  id: string
  name: string
  provider: string
  input: readonly string[]
  output: readonly string[]
}

export interface ModelMetadataCatalog {
  getMediaModels?: (providerId?: string) => readonly CatalogMediaModel[]
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
  readonly #mediaModels: CatalogMediaModel[] = []
  readonly #byProvider = new Map<string, CatalogModel[]>()

  constructor(data: unknown) {
    if (!isRecord(data))
      throw new Error('Invalid models.dev catalog')
    for (const [providerId, provider] of Object.entries(data)) {
      if (!isRecord(provider) || !isRecord(provider.models) || typeof provider.name !== 'string')
        throw new Error('Invalid models.dev provider')
      const models: CatalogModel[] = []
      for (const [modelId, raw] of Object.entries(provider.models)) {
        const model = isRecord(raw) && typeof raw.type === 'string' ? normalizeV2Model(raw) : raw
        if (!isRecord(model) || !isRecord(model.modalities) || !Array.isArray(model.modalities.input)
          || !Array.isArray(model.modalities.output)) {
          throw new Error('Invalid models.dev model')
        }
        if (typeof model.name !== 'string')
          throw new Error('Invalid models.dev model name')
        const type = model.type === undefined || model.type === 'chat' ? 'chat' : model.type === 'transcription' || model.type === 'speech' ? model.type : undefined
        const protocols = isRecord(model.api) ? model.api : {}
        const speechProtocol = type === 'transcription' ? protocols.transcriptions : type === 'speech' ? protocols.speech : undefined
        const baseUrl = typeof model.baseUrl === 'string' ? model.baseUrl : typeof provider.api === 'string' ? provider.api : SDK_BASE_URLS[String(provider.npm)] ?? ''
        this.#mediaModels.push({ id: modelId, name: model.name, provider: providerId, type, baseUrl: isRecord(speechProtocol) && typeof speechProtocol.base_url === 'string' ? speechProtocol.base_url : baseUrl, api: isOpenAiAudioProtocol(speechProtocol) ? 'openai-audio' : undefined, protocols: Object.keys(protocols), input: model.modalities.input.filter((item): item is string => typeof item === 'string'), output: model.modalities.output.filter((item): item is string => typeof item === 'string') })
        if (type !== 'chat' || !isRecord(model.limit))
          continue
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
          baseUrl,
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
    if (!this.#mediaModels.length)
      throw new Error('Empty models.dev catalog')
    freezeEventSnapshot(this.#providers)
    freezeEventSnapshot(this.#models)
    freezeEventSnapshot(this.#mediaModels)
    for (const models of this.#byProvider.values()) freezeEventSnapshot(models)
  }

  getProviders() {
    return this.#providers as ReadonlyArray<{ id: string, name: string }>
  }

  getMediaModels(providerId?: string): readonly CatalogMediaModel[] {
    return providerId ? this.#mediaModels.filter(model => model.provider === providerId) : this.#mediaModels
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

function normalizeV2Model(model: Record<string, unknown>): Record<string, unknown> {
  const capabilities = isRecord(model.capabilities) ? model.capabilities : {}
  const reasoning = isRecord(capabilities.reasoning) ? capabilities.reasoning : {}
  const tools = isRecord(capabilities.tools) ? capabilities.tools : {}
  const api = isRecord(model.api) ? model.api : {}
  const endpoint = Object.values(api).find(isRecord)
  const modalities = isRecord(model.modalities) ? model.modalities : {}
  const normalize = (values: unknown) => Array.isArray(values) ? [...new Set(values.map(value => typeof value === 'string' ? value === 'application/pdf' ? 'pdf' : value.split('/')[0] : value))] : []
  const cost = isRecord(model.cost) ? model.cost : {}
  const text = isRecord(cost.text) ? cost.text : {}
  const input = isRecord(text.input) ? text.input : {}
  const output = isRecord(text.output) ? text.output : {}
  const cache = isRecord(input.cache) ? input.cache : {}
  const overrides = Array.isArray(input.overrides) ? input.overrides : []
  const tiers = overrides.filter(isRecord).flatMap((entry) => {
    const when = isRecord(entry.when) ? entry.when : {}
    const context = isRecord(when.context) ? when.context : {}
    if (typeof context.gt !== 'number')
      return []
    const outputOverride = (Array.isArray(output.overrides) ? output.overrides : []).filter(isRecord).find(candidate => JSON.stringify(candidate.when) === JSON.stringify(entry.when))
    const cacheOverride = isRecord(entry.cache) ? entry.cache : {}
    return [{ tier: { type: 'context', size: context.gt }, input: entry.price, output: outputOverride?.price ?? output.price, cache_read: cacheOverride.read ?? cache.read, cache_write: cacheOverride.write ?? cache.write }]
  })
  const experimental = isRecord(model.experimental) ? model.experimental : {}
  const modes = isRecord(experimental.modes) ? experimental.modes : {}
  const fast = isRecord(modes.fast) ? modes.fast : {}
  return {
    ...model,
    baseUrl: endpoint?.base_url,
    modalities: { input: normalize(modalities.input), output: normalize(modalities.output) },
    tool_call: tools.supported,
    reasoning: reasoning.supported,
    reasoning_options: [
      ...(Array.isArray(reasoning.effort) ? [{ type: 'effort', values: reasoning.effort }] : []),
      ...(reasoning.toggle ? [{ type: 'toggle' }] : []),
    ],
    cost: { input: input.price, output: output.price, cache_read: cache.read, cache_write: cache.write, tiers },
    experimental: { modes: { fast: { provider: { body: fast.body } } } },
  }
}

function isOpenAiAudioProtocol(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.sdk))
    return false
  return value.sdk.opencodeai === '@opencode/ai/protocols/openai-transcription'
    || value.sdk.opencodeai === '@opencode/ai/protocols/openai-speech'
}
