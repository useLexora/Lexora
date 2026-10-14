export interface SyncAdapter {
  remove: (key: string, signal: AbortSignal) => Promise<void>
  test: (signal: AbortSignal) => Promise<void>
  prepare: (signal: AbortSignal) => Promise<void>
  list: (signal: AbortSignal) => Promise<string[]>
  read: (key: string, limit: number, signal: AbortSignal) => Promise<Uint8Array | null>
  write: (key: string, bytes: Uint8Array, signal: AbortSignal) => Promise<void>
}
export type SyncTransport = (url: string, init: {
  method: string
  headers: Record<string, string>
  body?: Uint8Array
  signal: AbortSignal
}) => Promise<Response>
export async function readLimitedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader)
    return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done)
        break
      length += chunk.value.length
      if (length > limit)
        throw new Error('SYNC_RESPONSE_TOO_LARGE')
      chunks.push(chunk.value)
    }
  }
  finally {
    await reader.cancel().catch(() => { })
    reader.releaseLock()
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
