import { Buffer } from 'node:buffer'
import { publicWebUrl, readResponseBytes } from '../../../platform/network/publicWebTransport'
import { WebError } from '../../../shared/network/webProtocol'
import { ImageGenerationError } from './ImageGenerationGateway'
import { runNativeImage } from './runNativeImage'

const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_RESPONSE_BYTES = Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 2 * 1024 * 1024
const MAX_IMAGE_URL_LENGTH = 8192
const MAX_IMAGE_URL_REDIRECTS = 3
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

export async function* readResponseChunks(response: Response, signal: AbortSignal): AsyncGenerator<string> {
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

export async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const parts: string[] = []
  for await (const chunk of readResponseChunks(response, signal))
    parts.push(chunk)
  return parts.join('')
}

export function decodePng(value: string): Uint8Array {
  if (!/^[A-Z0-9+/]*={0,2}$/i.test(value))
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
  return assertPng(new Uint8Array(Buffer.from(value, 'base64')))
}

export function readProviderImageItem(result: unknown): { b64_json?: string, url?: string } | undefined {
  if (!result || typeof result !== 'object' || !('data' in result) || !Array.isArray(result.data) || result.data.length !== 1)
    return undefined
  const item = result.data[0]
  if (!item || typeof item !== 'object')
    return undefined
  const record = item as Record<string, unknown>
  const b64 = typeof record.b64_json === 'string' ? record.b64_json : undefined
  const url = typeof record.url === 'string' ? record.url.trim() : undefined
  if (!b64 && !url)
    return undefined
  return { ...(b64 ? { b64_json: b64 } : {}), ...(url ? { url } : {}) }
}

export async function readGeneratedImageUrl(fetch: typeof globalThis.fetch, value: string, signal: AbortSignal): Promise<Uint8Array> {
  const seen = new Set<string>()
  let current = imageUrl(value)
  for (let redirect = 0; redirect <= MAX_IMAGE_URL_REDIRECTS; redirect++) {
    if (seen.has(current))
      throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
    seen.add(current)
    signal.throwIfAborted()
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal,
      headers: { accept: 'image/png,image/*;q=0.8' },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location || redirect === MAX_IMAGE_URL_REDIRECTS)
        throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
      current = imageUrl(new URL(location, current).toString())
      continue
    }
    if (!response.ok)
      throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_GENERATED_IMAGE_BYTES)
      throw new ImageGenerationError('IMAGE_GENERATION_RESPONSE_TOO_LARGE')
    return assertPng(await readImageBytes(response))
  }
  throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
}

function imageUrl(value: string): string {
  if (value.length > MAX_IMAGE_URL_LENGTH)
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
  try {
    return publicWebUrl(value).href
  }
  catch (cause) {
    if (cause instanceof WebError)
      throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE', { cause })
    throw cause
  }
}

function assertPng(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength > MAX_GENERATED_IMAGE_BYTES
    || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
  }
  return Buffer.isBuffer(bytes) ? new Uint8Array(bytes) : bytes
}

async function readImageBytes(response: Response): Promise<Uint8Array> {
  try {
    return await readResponseBytes(response, MAX_GENERATED_IMAGE_BYTES)
  }
  catch (cause) {
    if (cause instanceof WebError && cause.code === 'WEB_RESPONSE_TOO_LARGE')
      throw new ImageGenerationError('IMAGE_GENERATION_RESPONSE_TOO_LARGE', { cause })
    throw cause
  }
}

export async function validateGeneratedImages(images: readonly { bytes: Uint8Array, mimeType: string }[], signal: AbortSignal): Promise<void> {
  if (!images.length)
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
  for (const image of images) {
    try {
      if (image.mimeType !== 'image/png')
        throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
      await runNativeImage(image.bytes, { operation: 'validate', options: { mimeType: image.mimeType } }, signal)
    }
    catch (cause) {
      signal.throwIfAborted()
      throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE', { cause })
    }
  }
}
