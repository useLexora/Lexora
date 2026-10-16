import type { FileHandle } from 'node:fs/promises'
import { fileRange } from './fileRange'

export async function fileResponse(handle: FileHandle, size: number, mimeType: string, request: Request, lifetime: AbortSignal, onClose: () => void = () => {}, abortCode = 'RESOURCE_CANCELLED'): Promise<Response> {
  const signal = AbortSignal.any([request.signal, lifetime])
  let closed = false
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const close = async () => {
    if (closed)
      return
    closed = true
    signal.removeEventListener('abort', abort)
    onClose()
    await handle.close()
  }
  function abort() {
    controller?.error(new Error(abortCode))
    void close()
  }
  try {
    signal.throwIfAborted()
    const range = fileRange(size, request.headers.get('range'))
    const headers = { ...range.headers, 'content-type': mimeType, 'content-security-policy': 'default-src \'none\'; sandbox', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' }
    if (range.status === 416 || size === 0 || request.method === 'HEAD') {
      await close()
      return new Response(null, { status: range.status, headers })
    }
    let position = range.start
    const body = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted)
          abort()
      },
      async pull(next) {
        try {
          signal.throwIfAborted()
          const bytes = new Uint8Array(Math.min(64 * 1024, range.end - position + 1))
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, position)
          signal.throwIfAborted()
          if (!bytesRead)
            throw new Error('RESOURCE_FILE_CHANGED')
          position += bytesRead
          next.enqueue(bytes.subarray(0, bytesRead))
          if (position > range.end) {
            next.close()
            await close()
          }
        }
        catch (error) {
          if (!closed)
            next.error(error)
          await close()
        }
      },
      cancel: close,
    })
    return new Response(body, { status: range.status, headers })
  }
  catch (error) {
    await close()
    throw error
  }
}
