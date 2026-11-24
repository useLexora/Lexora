import type { ProviderService } from '../providers/ProviderService'
import type { ImageGenerationErrorDiagnostic, ImageGenerationInput, ImageGenerationResult } from './ImageGenerationGateway'
import { imageOutputOptionsSchema } from '../../../shared/images/imagePreferences'
import { ImageGenerationError } from './ImageGenerationGateway'
import { supportsImageRequest } from './imageGenerationSupport'
import { imageHttpFailure, imageResponseDiagnostic, imageTransportFailure } from './imageHttpDiagnostic'
import { decodePng, readBoundedResponse, readGeneratedImageUrl, readProviderImageItem } from './imageResponseBody'
import { resolveProviderImageAdapter } from './providerImageAdapters'

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
    const adapter = resolveProviderImageAdapter(request.baseUrl)
    if (!supportsImageRequest(adapter.support, input.inputImages.length ? 'edit' : 'generate', input.inputImages.length, output))
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
    const prepared = adapter.buildRequest(modelId, input, output)
    const headers = new Headers(request.headers)
    let body: string | FormData
    if (prepared.body instanceof FormData) {
      headers.delete('Content-Type')
      body = prepared.body
    }
    else {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(prepared.body)
    }
    const endpoint = `${request.baseUrl.replace(/\/+$/, '')}/${prepared.path}`
    const diagnostic: ImageGenerationErrorDiagnostic = { stage: 'submitting', localRequestId: input.requestId }
    const fallbackBody = omitResponseFormat(body)
    await input.onSubmitting?.()
    input.signal.throwIfAborted()
    try {
      let payload = body
      let usedFallback = false
      while (true) {
        const response = await this.fetch(endpoint, { method: 'POST', headers, body: payload, signal: input.signal, redirect: 'error' })
        clearResponseDiagnostic(diagnostic)
        Object.assign(diagnostic, imageResponseDiagnostic(response))
        if (!response.ok) {
          const failure = await imageHttpFailure(response, input.signal)
          if (!usedFallback && fallbackBody !== undefined && failure.diagnostic?.providerParameter === 'response_format') {
            payload = fallbackBody
            usedFallback = true
            continue
          }
          throw failure
        }
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
        const image = readProviderImageItem(JSON.parse(await readBoundedResponse(response, input.signal)))
        if (image?.b64_json)
          return { images: [{ bytes: decodePng(image.b64_json), mimeType: 'image/png' }], responseId }
        if (image?.url)
          return { images: [{ bytes: await readGeneratedImageUrl(this.fetch, image.url, input.signal), mimeType: 'image/png' }], responseId }
        throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
      }
    }
    catch (cause) {
      input.signal.throwIfAborted()
      if (cause instanceof ImageGenerationError)
        throw new ImageGenerationError(cause.code, { ...cause, cause, diagnostic: { ...diagnostic, ...cause.diagnostic } })
      throw imageTransportFailure(cause, diagnostic)
    }
  }
}

function clearResponseDiagnostic(diagnostic: ImageGenerationErrorDiagnostic) {
  delete diagnostic.httpStatus
  delete diagnostic.responseType
  delete diagnostic.providerCode
  delete diagnostic.providerParameter
  delete diagnostic.requestId
  delete diagnostic.responseId
}

function omitResponseFormat(body: string | FormData): string | FormData | undefined {
  if (typeof body === 'string') {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (!Object.hasOwn(parsed, 'response_format'))
      return undefined
    delete parsed.response_format
    return JSON.stringify(parsed)
  }
  if (!body.has('response_format'))
    return undefined
  const copy = new FormData()
  for (const [key, value] of body.entries()) {
    if (key !== 'response_format')
      copy.append(key, value)
  }
  return copy
}
