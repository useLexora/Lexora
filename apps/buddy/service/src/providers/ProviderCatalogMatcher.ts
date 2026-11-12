import type { ModelCatalogReference } from '../../../shared/providers/providerCatalog'
import type { CatalogModel, ModelMetadataCatalog } from './ModelsDevCatalog'
import { serializeModelMetadata } from './modelMetadata'
import { modelCatalogFingerprint, modelResolutionFingerprint } from './modelResolution'

export type CatalogModelDefaults = Partial<Pick<CatalogModel, 'input' | 'reasoning' | 'thinkingLevelMap' | 'contextWindow' | 'maxTokens' | 'pdfInput' | 'audioInput' | 'videoInput' | 'toolCall' | 'baseUrl'>>

export type ProviderCatalogMatch = {
  candidates: readonly CatalogModel[]
  model: CatalogModel
  status: 'matched'
} | {
  candidates: readonly CatalogModel[]
  defaults: CatalogModelDefaults
  status: 'ambiguous'
} | {
  candidates: readonly CatalogModel[]
  status: 'unmatched'
}

interface CatalogMatchInput {
  api: string
  baseUrl: string
  modelId: string
  providerId?: string
  selection?: ModelCatalogReference | null
}

const MODEL_ORIGINS: ReadonlyArray<{ pattern: RegExp, providers: readonly string[] }> = [
  { pattern: /^(?:gpt-|chatgpt-|o[134](?:-|$))/u, providers: ['openai'] },
  { pattern: /^claude-/u, providers: ['anthropic'] },
  { pattern: /^gemini-/u, providers: ['google'] },
  { pattern: /^deepseek-/u, providers: ['deepseek'] },
  { pattern: /^glm-/u, providers: ['zai', 'zhipuai'] },
  { pattern: /^(?:kimi-|moonshot-)/u, providers: ['moonshotai', 'moonshotai-cn'] },
  { pattern: /^minimax-/u, providers: ['minimax', 'minimax-cn'] },
  { pattern: /^grok-/u, providers: ['xai'] },
  { pattern: /^(?:qwen|qwq)/u, providers: ['alibaba', 'alibaba-cn'] },
  { pattern: /^(?:mistral-|magistral-|codestral-|devstral-|ministral-|pixtral-)/u, providers: ['mistral'] },
]

export class ProviderCatalogMatcher {
  readonly #runtime: ModelMetadataCatalog
  #fingerprint: string | undefined
  readonly #names = new Map<string, string>()
  readonly #models = new Map<string, CatalogModel>()
  readonly #identities = new Map<string, Set<CatalogModel>>()
  readonly #matches = new Map<string, ProviderCatalogMatch>()

  constructor(runtime: ModelMetadataCatalog) {
    this.#runtime = runtime
  }

  providerName(providerId: string): string {
    this.#index()
    return this.#names.get(providerId) ?? providerId
  }

  getFingerprint(): string {
    return modelResolutionFingerprint({ version: 2, catalog: this.#runtime.getFingerprint?.() ?? modelCatalogFingerprint(this.#runtime) })
  }

  #index(): void {
    const fingerprint = this.getFingerprint()
    if (this.#fingerprint === fingerprint)
      return
    this.#fingerprint = fingerprint
    this.#names.clear()
    this.#models.clear()
    this.#identities.clear()
    this.#matches.clear()
    for (const provider of this.#runtime.getProviders()) {
      this.#names.set(provider.id, provider.name)
      for (const model of this.#runtime.getModels(provider.id)) {
        this.#models.set(JSON.stringify([model.provider, model.id]), model)
        const id = model.id.trim().toLowerCase()
        const keys = [catalogModelKey(id)]
        const name = model.name.trim().toLowerCase().replace(/\s+/gu, '-')
        if (!/\d/u.test(id) && modelOrigins(name).includes(model.provider))
          keys.push(name, name.replace(/-(?:\d{8}|\d{4})$/u, ''))
        for (const key of keys) {
          const models = this.#identities.get(key) ?? new Set<CatalogModel>()
          models.add(model)
          this.#identities.set(key, models)
        }
      }
    }
  }

  match(input: CatalogMatchInput): ProviderCatalogMatch {
    this.#index()
    const key = serializeModelMetadata(input)
    const existing = this.#matches.get(key)
    if (existing)
      return existing
    const result = this.#match(input)
    if (this.#matches.size >= 2048)
      this.#matches.delete(this.#matches.keys().next().value!)
    this.#matches.set(key, result)
    return result
  }

  #match(input: CatalogMatchInput): ProviderCatalogMatch {
    const requested = input.modelId.trim().toLowerCase()
    let identity = requested
    let matches = matchIdentity([...(this.#identities.get(catalogModelKey(identity)) ?? [])], identity)
    if (!matches.length) {
      const thinkingAlias = catalogModelKey(requested).match(/^(gemini-\d[\w.-]*)-(?:minimal|low|medium|high)$/u)?.[1]
      if (thinkingAlias) {
        identity = thinkingAlias
        matches = matchIdentity([...(this.#identities.get(catalogModelKey(identity)) ?? [])], identity)
      }
    }
    const candidates = matches.map(match => match.model)
    candidates.sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id))
    const selection = input.selection
    if (selection) {
      const model = candidates.find(model => model.provider === selection.providerId
        && model.id === selection.modelId)
      if (!model)
        return { candidates, status: 'unmatched' }
      return { candidates, model, status: 'matched' }
    }
    if (candidates.length === 0)
      return { candidates, status: 'unmatched' }

    const normalizedBaseUrl = normalizeProviderBaseUrl(input.baseUrl)
    const endpointMatches = candidates.filter(model => (
      Boolean(normalizedBaseUrl) && normalizeProviderBaseUrl(model.baseUrl) === normalizedBaseUrl
    ))
    const providerId = input.providerId === 'openai-codex' ? 'openai' : input.providerId
    const providerMatches = candidates.filter(model => model.provider === providerId)
    let preferred = endpointMatches.length ? endpointMatches : providerMatches.length ? providerMatches : candidates
    if (!endpointMatches.length && !providerMatches.length) {
      const origins = modelOrigins(catalogModelKey(identity))
      for (const providerId of origins) {
        const models = candidates.filter(model => model.provider === providerId)
        if (models.length) {
          preferred = models
          break
        }
      }
    }
    const ranks = new Map(matches.map(match => [match.model, match.rank]))
    const highestRank = Math.max(...preferred.map(model => ranks.get(model)!))
    preferred = preferred.filter(model => ranks.get(model) === highestRank)
    return resolveCandidates(candidates, preferred)
  }

  matchReferences(references: readonly ModelCatalogReference[]): ProviderCatalogMatch {
    this.#index()
    const candidates = [...new Set(references.flatMap(reference => this.find(reference) ?? []))]
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id))
    return resolveCandidates(candidates)
  }

  find(reference: ModelCatalogReference): CatalogModel | undefined {
    this.#index()
    return this.#models.get(JSON.stringify([reference.providerId, reference.modelId]))
  }
}

function resolveCandidates(candidates: readonly CatalogModel[], preferred = candidates): ProviderCatalogMatch {
  const first = preferred[0]
  if (!first)
    return { candidates, status: 'unmatched' }
  const fingerprint = catalogCapabilityFingerprint(first)
  if (preferred.every(model => catalogCapabilityFingerprint(model) === fingerprint))
    return { candidates, model: first, status: 'matched' }
  return { candidates, defaults: commonMetadata(preferred), status: 'ambiguous' }
}

function catalogModelKey(value: string): string {
  const normalized = value.trim().toLowerCase()
  return normalized.match(/^[a-z0-9_-]+\/([^/]+)$/u)?.[1] ?? normalized
}

function modelOrigins(id: string): readonly string[] {
  return MODEL_ORIGINS.find(origin => origin.pattern.test(id))?.providers ?? []
}

function matchIdentity(models: readonly CatalogModel[], requested: string) {
  const key = catalogModelKey(requested)
  return models.flatMap((model) => {
    const id = model.id.trim().toLowerCase()
    if (id === requested)
      return [{ model, rank: 3 }]
    if (catalogModelKey(id) === key)
      return [{ model, rank: 2 }]
    const name = model.name.trim().toLowerCase().replace(/\s+/gu, '-')
    if (!/\d/u.test(id) && modelOrigins(name).includes(model.provider)
      && (name === key || name.replace(/-(?:\d{8}|\d{4})$/u, '') === key)) {
      return [{ model, rank: 1 }]
    }
    return []
  })
}

function commonMetadata(models: readonly CatalogModel[]): CatalogModelDefaults {
  const first = models[0]!
  const common = <Key extends keyof CatalogModelDefaults>(key: Key, value = first[key]) => models.every(model => serializeModelMetadata(model[key]) === serializeModelMetadata(value))
  const defaults: CatalogModelDefaults = {}
  for (const key of ['contextWindow', 'maxTokens', 'pdfInput', 'audioInput', 'videoInput', 'toolCall'] as const) {
    const values = models.map(model => model[key]).filter(value => value !== undefined)
    if (values.length && values.every(value => value === values[0]))
      Object.assign(defaults, { [key]: values[0] })
  }
  if (models.every(model => serializeModelMetadata([...new Set(model.input)].sort()) === serializeModelMetadata([...new Set(first.input)].sort())))
    defaults.input = [...first.input]
  if (common('reasoning') && common('thinkingLevelMap')) {
    defaults.reasoning = first.reasoning
    defaults.thinkingLevelMap = first.thinkingLevelMap
  }
  if (models.every(model => normalizeProviderBaseUrl(model.baseUrl) === normalizeProviderBaseUrl(first.baseUrl)))
    defaults.baseUrl = first.baseUrl
  return defaults
}

function catalogCapabilityFingerprint(model: CatalogModel): string {
  return serializeModelMetadata({
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...new Set(model.input)].sort(),
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap ?? null,
    pdfInput: model.pdfInput ?? false,
    audioInput: model.audioInput ?? false,
    videoInput: model.videoInput ?? false,
    toolCall: model.toolCall,
  })
}

export function normalizeProviderBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    const pathname = url.pathname
      .replace(/\/+$/u, '')
      .replace(/\/(?:v1|v1beta|v1alpha)$/iu, '')
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}`
  }
  catch {
    return value.trim().replace(/\/+$/u, '').toLowerCase()
  }
}
