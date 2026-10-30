import type { Api, Model } from '@earendil-works/pi-ai'
import type { ImageCandidate, ImageCatalog, ImagePreferences, ImageSupport, ImageTarget } from '../../../shared/images/imagePreferences'
import type { ProviderService } from '../providers/ProviderService'
import type { ImageGenerationGateway, ImageGenerationInput, ImageGenerationResult } from './ImageGenerationGateway'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { imageOutputOptionsSchema, imagePolicyTargets, resolveImagePolicy } from '../../../shared/images/imagePreferences'
import { ImageGenerationError } from './ImageGenerationGateway'
import { ProviderImageService } from './ProviderImageService'

export const nativeImageSupport: ImageSupport = {
  operations: ['generate', 'edit'],
  maxReferenceImages: 4,
  sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
  qualities: ['auto', 'low', 'medium', 'high'],
  backgrounds: ['auto', 'opaque', 'transparent'],
}

export interface ImageGenerationBackend {
  candidates: (signal?: AbortSignal) => Promise<ImageCandidate[]>
  generate: (target: ImageTarget, input: ImageGenerationInput) => Promise<ImageGenerationResult>
}

interface RoutedImageGatewayOptions {
  native: ImageGenerationGateway
  plugins?: ImageGenerationBackend
  providers: ProviderService
  preferences: () => Promise<ImagePreferences>
}

export class RoutedImageGateway implements ImageGenerationGateway {
  readonly options: RoutedImageGatewayOptions
  constructor(options: RoutedImageGatewayOptions) { this.options = options }

  supports(_model: Model<Api>): boolean { return true }

  async catalog(): Promise<ImageCatalog> {
    const [preferences, plugins, providers] = await Promise.all([this.options.preferences(), this.options.plugins?.candidates() ?? [], this.options.providers.listProviders()])
    const candidates: ImageCandidate[] = [...plugins]
    for (const model of await this.options.providers.listModels()) {
      const provider = providers.find(provider => provider.id === model.providerId)
      if (model.type === 'image-generation' && model.api === 'openai-images') {
        candidates.push({ target: { kind: 'model', providerId: model.providerId, modelId: model.id }, title: model.displayName, owner: provider?.displayName ?? model.providerId, available: Boolean(model.available && model.enabled && provider?.enabled && provider.status === 'available'), managementPage: true, support: nativeImageSupport })
        continue
      }
      try {
        const resolved = this.options.providers.executionModels.resolve({ providerId: model.providerId, modelId: model.id, contextWindow: null, maxTokens: null })
        if (this.options.native.supports(resolved))
          candidates.push({ target: { kind: 'model', providerId: model.providerId, modelId: model.id }, title: model.displayName, owner: provider?.displayName ?? model.providerId, available: Boolean(model.available && model.enabled && provider?.enabled && provider.status === 'available'), managementPage: true, support: nativeImageSupport })
      }
      catch { continue }
    }
    return { candidates, readingCandidates: [], preferences }
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    input.signal.throwIfAborted()
    const operation = input.inputImages.length ? 'edit' : 'generate'
    const policy = resolveImagePolicy(input.preferences ?? await this.options.preferences(), operation)
    const output = imageOutputOptionsSchema.parse(input.output ?? {})
    const current: ImageTarget = { kind: 'model', providerId: input.model.provider, modelId: input.model.id }
    const nativeSupported = this.options.native.supports(input.model) && this.#supports(nativeImageSupport, operation, input.inputImages.length, output)
    const targets = policy.mode === 'native' ? [current] : [...policy.mode === 'auto' && nativeSupported ? [current] : [], ...imagePolicyTargets(policy)]
    if (!targets.length)
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
    const plugins = targets.some(target => target.kind === 'plugin') ? await this.options.plugins?.candidates(input.signal) ?? [] : []
    const requestId = input.requestId ?? randomUUID()
    const visited = new Set<string>()
    let failure: unknown
    for (const [index, target] of targets.entries()) {
      const key = JSON.stringify(target)
      if (visited.has(key))
        continue
      visited.add(key)
      input.signal.throwIfAborted()
      try {
        const plugin = target.kind === 'plugin' ? plugins.find(candidate => JSON.stringify(candidate.target) === JSON.stringify(target)) : undefined
        this.#assertSupport(target, plugin, operation, input.inputImages.length, output)
        await input.onAttempt?.(target, index + 1)
        const onSubmitted = (backendRequestId: string) => input.onAttempt?.(target, index + 1, backendRequestId) ?? Promise.resolve()
        if (plugin && input.inputImages.some(image => !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)))
          throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
        let result: ImageGenerationResult
        let title: string
        let owner: string
        if (plugin) {
          if (!plugin.available || !this.options.plugins)
            throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
          title = plugin.title
          owner = plugin.owner
          result = await this.options.plugins.generate(target, { ...input, requestId, output, onSubmitted })
        }
        else {
          if (target.kind !== 'model')
            throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
          const selected = (await this.options.providers.listModels(target.providerId)).find(model => model.id === target.modelId)
          if (selected?.type === 'image-generation') {
            title = selected.displayName
            owner = target.providerId
            result = await new ProviderImageService(this.options.providers).generate(target.providerId, target.modelId, { ...input, requestId, output, onSubmitted })
          }
          else {
            let model: Model<Api>
            if (target.providerId === current.providerId && target.modelId === current.modelId) {
              model = input.model
            }
            else {
              try {
                model = await this.options.providers.executionModels.resolveAvailable({ providerId: target.providerId, modelId: target.modelId, contextWindow: null, maxTokens: null })
              }
              catch (cause) {
                throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { cause, retryable: true })
              }
            }
            if (!this.options.native.supports(model))
              throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
            title = model.name
            owner = model.provider
            result = await this.options.native.generate({ ...input, model, requestId, output, onSubmitted })
          }
        }
        if (output.size !== 'auto') {
          const [width, height] = output.size.split('x').map(Number)
          if (result.images.some(image => image.bytes.byteLength < 24 || Buffer.from(image.bytes).readUInt32BE(16) !== width || Buffer.from(image.bytes).readUInt32BE(20) !== height))
            throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
        }
        return { ...result, source: { target, requestId, attempt: index + 1, title, owner } }
      }
      catch (error) {
        input.signal.throwIfAborted()
        if (!(error instanceof ImageGenerationError) || !error.retryable || error.code === 'IMAGE_GENERATION_INCOMPLETE')
          throw error
        failure = error
      }
    }
    throw failure ?? new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED')
  }

  #assertSupport(target: ImageTarget, plugin: ImageCandidate | undefined, operation: 'generate' | 'edit', references: number, output: ReturnType<typeof imageOutputOptionsSchema.parse>) {
    const support = target.kind === 'plugin' ? plugin?.support : nativeImageSupport
    if (!support || !this.#supports(support, operation, references, output))
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
  }

  #supports(support: ImageSupport, operation: 'generate' | 'edit', references: number, output: ReturnType<typeof imageOutputOptionsSchema.parse>): boolean {
    return support.operations.includes(operation) && references <= support.maxReferenceImages && support.sizes.includes(output.size) && support.qualities.includes(output.quality) && support.backgrounds.includes(output.background)
  }
}
