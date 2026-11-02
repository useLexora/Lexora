import type {
  Api,
  AuthResult,
  AuthType,
  Model,
} from '@earendil-works/pi-ai'
import type {
  ImageGenerationErrorDiagnostic,
  ImageGenerationGateway,
  ImageGenerationInput,
  ImageGenerationResult,
} from './ImageGenerationGateway'
import { Buffer } from 'node:buffer'
import { imageGenerationDiagnosticSchema, readImageDiagnostic } from '../../../shared/images/imageGeneration'
import { ImageGenerationError } from './ImageGenerationGateway'
import { imageHttpFailure, imageResponseDiagnostic, imageTransportFailure } from './imageHttpDiagnostic'
import { decodePng, readBoundedResponse, readResponseChunks } from './imageResponseBody'

export interface OpenAiImageGenerationServiceOptions {
  fetch?: typeof globalThis.fetch
  resolveCredentialMetadata: (providerId: string) => { readonly type: AuthType, readonly revision: number } | null
  resolveSourceProviderId?: (providerId: string) => string
  modelRuntime: {
    getAuth: (
      model: Model<Api>,
      options?: { signal?: AbortSignal },
    ) => Promise<AuthResult | undefined>
  }
}

export class OpenAiImageGenerationService implements ImageGenerationGateway {
  readonly #fetch: typeof globalThis.fetch
  readonly #resolveCredentialMetadata: OpenAiImageGenerationServiceOptions['resolveCredentialMetadata']
  readonly #resolveSourceProviderId: (providerId: string) => string
  readonly #modelRuntime: OpenAiImageGenerationServiceOptions['modelRuntime']

  constructor(options: OpenAiImageGenerationServiceOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#resolveCredentialMetadata = options.resolveCredentialMetadata
    this.#resolveSourceProviderId = options.resolveSourceProviderId ?? (providerId => providerId)
    this.#modelRuntime = options.modelRuntime
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const credential = this.#resolveCredentialMetadata(input.model.provider)
    if (!this.#supportsCredential(input.model, credential?.type ?? null))
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
    input.signal.throwIfAborted()
    let auth: AuthResult | undefined
    try {
      auth = await this.#modelRuntime.getAuth(input.model, { signal: input.signal })
    }
    catch (error) {
      input.signal.throwIfAborted()
      throw new ImageGenerationError('PROVIDER_AUTHENTICATION_FAILED', { cause: error, retryable: true })
    }
    input.signal.throwIfAborted()
    const current = this.#resolveCredentialMetadata(input.model.provider)
    if (current?.revision !== credential?.revision || !this.#supportsCredential(input.model, current?.type ?? null))
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED')
    const apiKey = auth?.auth.apiKey
    if (!auth || !apiKey)
      throw new ImageGenerationError('PROVIDER_AUTHENTICATION_FAILED', { retryable: true })

    const codex = input.model.api === 'openai-codex-responses'
    const headers = createHeaders(input.model, auth, codex)
    const endpoint = resolveEndpoint(input.model, auth, codex)
    const diagnostic: ImageGenerationErrorDiagnostic = { stage: 'submitting', localRequestId: input.requestId }
    await input.onSubmitting?.()
    input.signal.throwIfAborted()
    const response = await this.#fetch(endpoint, {
      body: JSON.stringify(createRequestBody(input, codex)),
      headers,
      method: 'POST',
      signal: input.signal,
    }).catch((cause: unknown) => {
      input.signal.throwIfAborted()
      throw imageTransportFailure(cause, diagnostic)
    })
    Object.assign(diagnostic, imageResponseDiagnostic(response))
    if (!response.ok) {
      const failure = await imageHttpFailure(response, input.signal)
      throw new ImageGenerationError(failure.code, { ...failure, diagnostic: { ...diagnostic, ...failure.diagnostic } })
    }
    const backendRequestId = diagnostic.requestId
    if (backendRequestId && input.onSubmitted) {
      try {
        await input.onSubmitted(backendRequestId)
      }
      catch (error) {
        await response.body?.cancel().catch(() => {})
        throw new ImageGenerationError('IMAGE_GENERATION_INCOMPLETE', { cause: error, diagnostic })
      }
    }

    let output: ImageGenerationResult
    try {
      output = codex
        ? await readSseOutput(response, input.signal, diagnostic)
        : parseJsonOutput(await readBoundedResponse(response, input.signal), response)
    }
    catch (error) {
      input.signal.throwIfAborted()
      if (error instanceof ImageGenerationError)
        throw new ImageGenerationError(error.code, { ...error, cause: error, diagnostic: { ...diagnostic, ...error.diagnostic } })
      throw imageTransportFailure(error, diagnostic)
    }
    if (output.images.length === 0)
      throw new ImageGenerationError('IMAGE_GENERATION_FAILED', { diagnostic })
    return output
  }

  supports(model: Model<Api>): boolean {
    return this.#supportsCredential(model, this.#resolveCredentialMetadata(model.provider)?.type ?? null)
  }

  #supportsCredential(model: Model<Api>, credentialType: AuthType | null): boolean {
    return supportsOpenAiImageGeneration(model, credentialType, this.#resolveSourceProviderId(model.provider))
  }
}

export function supportsOpenAiImageGeneration(model: Model<Api>, credentialType: AuthType | null, sourceProviderId = model.provider): boolean {
  return (
    sourceProviderId === 'openai'
    && model.api === 'openai-responses'
    && credentialType === 'api_key'
  ) || (
    sourceProviderId === 'openai-codex'
    && model.api === 'openai-codex-responses'
    && credentialType === 'oauth'
  )
}

function createRequestBody(input: ImageGenerationInput, stream: boolean) {
  return {
    input: [{
      content: [
        { text: input.prompt, type: 'input_text' },
        ...input.inputImages.map(image => ({
          image_url: `data:${image.mimeType};base64,${image.data}`,
          type: 'input_image',
        })),
      ],
      role: 'user',
    }],
    model: input.model.id,
    parallel_tool_calls: false,
    store: false,
    stream,
    tool_choice: { type: 'image_generation' },
    tools: [{
      action: input.inputImages.length > 0 ? 'edit' : 'generate',
      background: input.output?.background ?? 'auto',
      output_format: 'png',
      quality: input.output?.quality ?? 'auto',
      size: input.output?.size ?? 'auto',
      type: 'image_generation',
    }],
  }
}

function createHeaders(
  model: Model<Api>,
  auth: AuthResult,
  codex: boolean,
): Headers {
  const headers = new Headers(model.headers)
  for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
    if (value === null)
      headers.delete(name)
    else
      headers.set(name, value)
  }
  headers.set('authorization', `Bearer ${auth.auth.apiKey}`)
  headers.set('content-type', 'application/json')
  if (!codex)
    return headers

  const accountId = extractChatGptAccountId(auth.auth.apiKey!)
  headers.set('accept', 'text/event-stream')
  headers.set('chatgpt-account-id', accountId)
  headers.set('openai-beta', 'responses=experimental')
  headers.set('originator', 'pi')
  return headers
}

function resolveEndpoint(model: Model<Api>, auth: AuthResult, codex: boolean): string {
  const baseUrl = (auth.auth.baseUrl ?? model.baseUrl).replace(/\/+$/, '')
  return codex ? `${baseUrl}/codex/responses` : `${baseUrl}/responses`
}

function extractChatGptAccountId(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length !== 3)
      throw new Error('invalid token')
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown
    const auth = readRecord(readRecord(payload)?.['https://api.openai.com/auth'])
    const accountId = auth?.chatgpt_account_id
    if (typeof accountId !== 'string' || !accountId)
      throw new Error('missing account')
    return accountId
  }
  catch (error) {
    throw new ImageGenerationError('PROVIDER_AUTHENTICATION_FAILED', { cause: error })
  }
}

function parseJsonOutput(body: string, response: Response): ImageGenerationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  }
  catch (error) {
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE', { cause: error })
  }
  const record = readRecord(parsed)
  if (record?.error || record?.status !== 'completed') {
    throw new ImageGenerationError('IMAGE_GENERATION_FAILED', {
      diagnostic: readProviderErrorDiagnostic(response, record),
    })
  }
  return {
    images: extractImages(record?.output),
    responseId: readString(record, 'id'),
  }
}

async function readSseOutput(response: Response, signal: AbortSignal, diagnostic: ImageGenerationErrorDiagnostic): Promise<ImageGenerationResult> {
  const outputItems: unknown[] = []
  let responseId: string | null = null
  for await (const data of readSseData(readResponseChunks(response, signal))) {
    if (!data.trim())
      continue
    if (data.trim() === '[DONE]') {
      diagnostic.lastEvent = '[DONE]'
      return { images: extractImages(outputItems), responseId }
    }
    let event: unknown
    try {
      event = JSON.parse(data)
    }
    catch (error) {
      throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE', { cause: error })
    }
    const eventRecord = readRecord(event)
    if (!eventRecord)
      throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
    const result = readRecord(eventRecord.response)
    responseId = readString(result, 'id') ?? responseId
    const type = eventRecord.type
    const lastEvent = imageGenerationDiagnosticSchema.shape.lastEvent.safeParse(type)
    diagnostic.lastEvent = lastEvent.success ? lastEvent.data : 'other'
    Object.assign(diagnostic, readImageDiagnostic({ responseId }))
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete' || type === 'response.cancelled' || eventRecord.error || result?.error) {
      throw new ImageGenerationError('IMAGE_GENERATION_FAILED', {
        diagnostic: readProviderErrorDiagnostic(response, result ?? eventRecord),
      })
    }
    if (type === 'response.output_item.done')
      outputItems.push(eventRecord.item)
    if (type === 'response.completed' || type === 'response.done') {
      if (!result || (result.status !== undefined && result.status !== 'completed')) {
        throw new ImageGenerationError('IMAGE_GENERATION_FAILED', {
          diagnostic: readProviderErrorDiagnostic(response, result),
        })
      }
      if (Array.isArray(result.output))
        outputItems.push(...result.output)
      return { images: extractImages(outputItems), responseId }
    }
  }
  throw new ImageGenerationError('IMAGE_GENERATION_INCOMPLETE', { diagnostic: readProviderErrorDiagnostic(response, null) })
}

async function* readSseData(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let line = ''
  let data: string[] = []
  let skipLineFeed = false
  const accept = (value: string) => {
    if (value === 'data')
      data.push('')
    else if (value.startsWith('data:'))
      data.push(value.slice(5).replace(/^ /, ''))
  }
  for await (let chunk of chunks) {
    if (!chunk)
      continue
    if (skipLineFeed && chunk.startsWith('\n'))
      chunk = chunk.slice(1)
    skipLineFeed = chunk.endsWith('\r')
    const lines = chunk.split(/\r\n|[\r\n]/)
    lines[0] = line + lines[0]
    line = lines.pop()!
    for (const value of lines) {
      if (value === '') {
        if (data.length > 0)
          yield data.join('\n')
        data = []
      }
      else {
        accept(value)
      }
    }
  }
  accept(line)
  if (data.length > 0)
    yield data.join('\n')
}

function extractImages(output: unknown): ImageGenerationResult['images'] {
  if (!Array.isArray(output))
    return []
  const seen = new Set<string>()
  return output.flatMap((item) => {
    const record = readRecord(item)
    if (record?.type !== 'image_generation_call' || record.status !== 'completed')
      return []
    const result = readString(record, 'result')
    if (!result || seen.has(result))
      return []
    seen.add(result)
    return [{ bytes: decodePng(result), mimeType: 'image/png' as const }]
  })
}

function readProviderErrorDiagnostic(response: Response, body: unknown): ImageGenerationErrorDiagnostic {
  return imageResponseDiagnostic(response, body)
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: Record<string, unknown> | null, key: string): string | null {
  const candidate = value?.[key]
  return typeof candidate === 'string' && candidate ? candidate : null
}
