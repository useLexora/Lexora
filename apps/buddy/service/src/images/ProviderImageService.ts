import type { ProviderService } from '../providers/ProviderService'
import type { ImageGenerationErrorDiagnostic, ImageGenerationInput, ImageGenerationResult } from './ImageGenerationGateway'
import { Buffer } from 'node:buffer'
import { imageOutputOptionsSchema } from '../../../shared/images/imagePreferences'
import { ImageGenerationError } from './ImageGenerationGateway'
import { imageHttpFailure, imageResponseDiagnostic, imageTransportFailure } from './imageHttpDiagnostic'
import { decodePng, readBoundedResponse } from './imageResponseBody'

export class ProviderImageService {
  readonly providers: ProviderService
  readonly fetch: typeof globalThis.fetch

  constructor(providers: ProviderService, fetch = globalThis.fetch) {
    this.providers = providers
    this.fetch = fetch
  }

  async generate(providerId: string, modelId: string, input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const selection = async () => {
      const [models, providers] = await Promise.all([this.providers.listModels(providerId), this.providers.listProviders()])
      const model = models.find(model => model.id === modelId)
      const provider = providers.find(provider => provider.id === providerId)
      if (!model?.enabled || !model.available || model.type !== 'image-generation' || model.api !== 'openai-images' || !provider?.enabled || provider.status !== 'available')
        throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
      return JSON.stringify([model, provider.baseUrl, provider.requestHeaders, this.providers.getCredentialMetadata(providerId)])
    }
    const selected = await selection()
    let request: Awaited<ReturnType<ProviderService['prepareModelRequest']>>
    try {
      request = await this.providers.prepareModelRequest(providerId, input.signal)
    }
    catch (cause) {
      input.signal.throwIfAborted()
      throw new ImageGenerationError('PROVIDER_AUTHENTICATION_FAILED', { cause, retryable: true })
    }
    if (selected !== await selection())
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
    input.signal.throwIfAborted()
    const output = imageOutputOptionsSchema.parse(input.output ?? {})
    const fields = { model: modelId, prompt: input.prompt, n: 1, output_format: 'png', ...Object.fromEntries(Object.entries(output).filter(([, value]) => value !== 'auto')) }
    const headers = new Headers(request.headers)
    let body: string | FormData
    if (input.inputImages.length) {
      const form = new FormData()
      for (const [name, value] of Object.entries(fields))
        form.set(name, String(value))
      let total = 0
      for (const [index, image] of input.inputImages.entries()) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType))
          throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
        const bytes = Buffer.from(image.data, 'base64')
        total += bytes.byteLength
        if (total > 32 * 1024 * 1024)
          throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
        form.append('image[]', new Blob([bytes], { type: image.mimeType }), `reference-${index}.${image.mimeType.split('/')[1]}`)
      }
      headers.delete('Content-Type')
      body = form
    }
    else {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(fields)
    }
    const endpoint = `${request.baseUrl.replace(/\/$/, '')}/images/${input.inputImages.length ? 'edits' : 'generations'}`
    const diagnostic: ImageGenerationErrorDiagnostic = { stage: 'submitting', localRequestId: input.requestId }
    await input.onSubmitting?.()
    input.signal.throwIfAborted()
    try {
      const response = await this.fetch(endpoint, { method: 'POST', headers, body, signal: input.signal, redirect: 'error' })
      Object.assign(diagnostic, imageResponseDiagnostic(response))
      if (!response.ok)
        throw await imageHttpFailure(response, input.signal)
      const responseId = diagnostic.requestId ?? null
      if (responseId) {
        try {
          await input.onSubmitted?.(responseId)
        }
        catch (cause) {
          await response.body?.cancel().catch(() => {})
          throw cause
        }
      }
      const result = JSON.parse(await readBoundedResponse(response, input.signal))
      if (!Array.isArray(result?.data) || result.data.length !== 1 || typeof result.data[0]?.b64_json !== 'string')
        throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
      return { images: [{ bytes: decodePng(result.data[0].b64_json), mimeType: 'image/png' }], responseId }
    }
    catch (cause) {
      input.signal.throwIfAborted()
      if (cause instanceof ImageGenerationError)
        throw new ImageGenerationError(cause.code, { ...cause, cause, diagnostic: { ...diagnostic, ...cause.diagnostic } })
      throw imageTransportFailure(cause, diagnostic)
    }
  }
}
