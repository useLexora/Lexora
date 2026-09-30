import type {
  Api,
  AuthResult,
  Model,
} from '@earendil-works/pi-ai'
import type {
  ImageGenerationErrorDiagnostic,
  ImageGenerationGateway,
  ImageGenerationInput,
  ImageGenerationResult,
} from './ImageGenerationGateway'
import { Buffer } from 'node:buffer'
import { ImageGenerationError } from './ImageGenerationGateway'

const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_RESPONSE_BYTES = Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 2 * 1024 * 1024
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

export interface OpenAiImageGenerationServiceOptions {
  fetch?: typeof globalThis.fetch
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
  readonly #resolveSourceProviderId: (providerId: string) => string
  readonly #modelRuntime: OpenAiImageGenerationServiceOptions['modelRuntime']

  constructor(options: OpenAiImageGenerationServiceOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#resolveSourceProviderId = options.resolveSourceProviderId ?? (providerId => providerId)
    this.#modelRuntime = options.modelRuntime
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    if (!this.supports(input.model))
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED')
    input.signal.throwIfAborted()
    let auth: AuthResult | undefined
    try {
      auth = await this.#modelRuntime.getAuth(input.model, { signal: input.signal })
    }
    catch (error) {
      input.signal.throwIfAborted()
      throw new ImageGenerationError('PROVIDER_AUTHENTICATION_FAILED', { cause: error })
    }
    input.signal.throwIfAborted()
    const apiKey = auth?.auth.apiKey
    if (!auth || !apiKey)
      throw new ImageGenerationError('PROVIDER_AUTHENTICATION_FAILED')

    const codex = input.model.api === 'openai-codex-responses'
    const headers = createHeaders(input.model, auth, codex)
    const endpoint = resolveEndpoint(input.model, auth, codex)
    const response = await this.#fetch(endpoint, {
      body: JSON.stringify(createRequestBody(input, codex)),
      headers,
      method: 'POST',
      signal: input.signal,
    })
    if (!response.ok) {
      const body = await readBoundedResponse(response, input.signal)
      throw new ImageGenerationError(normalizeProviderError(response.status), {
        diagnostic: readProviderErrorDiagnostic(response, body),
      })
    }

    let output: ImageGenerationResult
    try {
      output = codex
        ? await readSseOutput(response, input.signal)
        : parseJsonOutput(await readBoundedResponse(response, input.signal), response)
    }
    catch (error) {
      input.signal.throwIfAborted()
      if (error instanceof ImageGenerationError)
        throw error
      throw new ImageGenerationError('IMAGE_GENERATION_INCOMPLETE', { cause: error, diagnostic: readProviderErrorDiagnostic(response, null) })
    }
    if (output.images.length === 0)
      throw new ImageGenerationError('IMAGE_GENERATION_FAILED')
    return output
  }

  supports(model: Model<Api>): boolean {
    return supportsOpenAiImageGeneration(model, this.#resolveSourceProviderId(model.provider))
  }
}

export function supportsOpenAiImageGeneration(model: Model<Api>, sourceProviderId = model.provider): boolean {
  return (
    sourceProviderId === 'openai'
    && model.api === 'openai-responses'
  ) || (
    sourceProviderId === 'openai-codex'
    && model.api === 'openai-codex-responses'
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
      background: 'auto',
      output_format: 'png',
      quality: 'auto',
      size: 'auto',
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

async function* readResponseChunks(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) {
    signal.throwIfAborted()
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let receivedBytes = 0
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES)
      throw new ImageGenerationError('IMAGE_GENERATION_RESPONSE_TOO_LARGE')
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) {
        yield decoder.decode()
        return
      }
      receivedBytes += chunk.value.byteLength
      if (receivedBytes > MAX_RESPONSE_BYTES)
        throw new ImageGenerationError('IMAGE_GENERATION_RESPONSE_TOO_LARGE')
      yield decoder.decode(chunk.value, { stream: true })
    }
  }
  finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const parts: string[] = []
  for await (const chunk of readResponseChunks(response, signal))
    parts.push(chunk)
  return parts.join('')
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

async function readSseOutput(response: Response, signal: AbortSignal): Promise<ImageGenerationResult> {
  const outputItems: unknown[] = []
  let responseId: string | null = null
  for await (const data of readSseData(readResponseChunks(response, signal))) {
    if (!data.trim())
      continue
    if (data.trim() === '[DONE]')
      return { images: extractImages(outputItems), responseId }
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

function decodePng(value: string): Uint8Array {
  if (!/^[A-Z0-9+/]*={0,2}$/i.test(value))
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
  const bytes = Buffer.from(value, 'base64')
  if (
    bytes.byteLength > MAX_GENERATED_IMAGE_BYTES
    || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
  }
  return new Uint8Array(bytes)
}

function normalizeProviderError(status: number) {
  if (status === 401)
    return 'PROVIDER_AUTHENTICATION_FAILED'
  if (status === 403)
    return 'PROVIDER_ACCESS_DENIED'
  if (status === 429)
    return 'PROVIDER_RATE_LIMITED'
  return 'IMAGE_GENERATION_FAILED'
}

function readProviderErrorDiagnostic(
  response: Response,
  body: unknown,
): ImageGenerationErrorDiagnostic | undefined {
  let record = readRecord(body)
  try {
    if (typeof body === 'string')
      record = readRecord(JSON.parse(body))
  }
  catch {}
  const error = readRecord(record?.error) ?? record
  const providerCode = readDiagnosticValue(error?.code)
  const providerParameter = readDiagnosticValue(error?.param)
    ?? readDiagnosticValue(error?.parameter)
  const requestId = readDiagnosticValue(response.headers.get('x-request-id'))
    ?? readDiagnosticValue(response.headers.get('openai-request-id'))
  if (!providerCode && !providerParameter && !requestId)
    return undefined
  return {
    ...(providerCode ? { providerCode } : {}),
    ...(providerParameter ? { providerParameter } : {}),
    ...(requestId ? { requestId } : {}),
  }
}

function readDiagnosticValue(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const result = value.trim()
  return result && result.length <= 256 && isDiagnosticToken(result)
    ? result
    : null
}

function isDiagnosticToken(value: string): boolean {
  const allowedCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-[]:/'
  return [...value].every(character => allowedCharacters.includes(character))
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
