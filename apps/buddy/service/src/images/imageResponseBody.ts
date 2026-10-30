import { Buffer } from 'node:buffer'
import { ImageGenerationError } from './ImageGenerationGateway'

const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_RESPONSE_BYTES = Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 2 * 1024 * 1024
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
  const bytes = Buffer.from(value, 'base64')
  if (
    bytes.byteLength > MAX_GENERATED_IMAGE_BYTES
    || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE')
  }
  return new Uint8Array(bytes)
}
