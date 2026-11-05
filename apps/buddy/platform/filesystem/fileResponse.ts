import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { fileRange } from './fileRange'

export async function assertFileSnapshot(handle: FileHandle, path: string, before: BigIntStats): Promise<void> {
  for (const after of [await handle.stat({ bigint: true }), await lstat(path, { bigint: true })]) {
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error('RESOURCE_FILE_CHANGED')
  }
}

export async function fileResponse(handle: FileHandle, size: number, mimeType: string, request: Request, lifetime: AbortSignal, onClose: () => void = () => {}, abortCode = 'RESOURCE_CANCELLED', verify?: () => Promise<void>, beforeRead?: (position: number) => Promise<void>): Promise<Response> {
  const signal = AbortSignal.any([request.signal, lifetime])
  let closing: Promise<void> | undefined
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const close = () => {
    closing ??= (async () => {
      signal.removeEventListener('abort', abort)
      try {
        await handle.close()
      }
      finally { onClose() }
    })()
    return closing
  }
  function abort() {
    controller?.error(new Error(abortCode))
    void close().catch(() => {})
  }
  const finish = async () => {
    await verify?.()
    signal.throwIfAborted()
    await close()
    signal.throwIfAborted()
  }
  try {
    signal.throwIfAborted()
    const range = fileRange(size, request.headers.get('range'))
    const headers = { ...range.headers, 'content-type': mimeType, 'content-security-policy': 'default-src \'none\'; sandbox', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' }
    if (range.status === 416 || size === 0 || request.method === 'HEAD') {
      await finish()
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
          await beforeRead?.(position)
          signal.throwIfAborted()
          const bytes = new Uint8Array(Math.min(64 * 1024, range.end - position + 1))
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, position)
          signal.throwIfAborted()
          if (!bytesRead)
            throw new Error('RESOURCE_FILE_CHANGED')
          position += bytesRead
          if (position > range.end)
            await finish()
          signal.throwIfAborted()
          next.enqueue(bytes.subarray(0, bytesRead))
          if (position > range.end)
            next.close()
        }
        catch (error) {
          await close()
          next.error(error)
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
