import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PRODUCT_LIMITS } from '../../shared/productProtocol/limits'

export const readPartMethod = 'service.readResultPart'
export const releaseReadMethod = 'service.releaseReadResult'
export const pagedServiceReads = new Set([
  'conversations.listTimeline',
  'conversations.getNodeDetail',
  'conversations.getTree',
  'conversations.listMessages',
  'runs.listEvents',
  'runs.readEventPage',
  'executions.detail',
  'executions.events',
  'executions.inputs',
])
const partBytes = PRODUCT_LIMITS.pageBytes / 2
const capacity = 64 * 1024 * 1024
const lifetimeMs = PRODUCT_LIMITS.snapshotLifetimeMs
const descriptor = z.object({ readTransfer: z.uuid(), byteLength: z.number().int().positive().max(capacity) }).strict()
const requestSchema = z.object({ readTransfer: z.uuid(), offset: z.number().int().nonnegative().max(capacity) }).strict()

export class ServiceReadTransfer {
  readonly #pending = new Map<string, { bytes: Buffer, offset: number, timeout: NodeJS.Timeout }>()
  #bytes = 0

  encode(value: unknown): unknown {
    const json = JSON.stringify(value)
    const byteLength = json === undefined ? 0 : Buffer.byteLength(json)
    if (byteLength <= PRODUCT_LIMITS.pageBytes)
      return value
    if (byteLength > capacity - this.#bytes || this.#pending.size >= 16)
      throw Object.assign(new RangeError('RPC_PAYLOAD_TOO_LARGE'), { code: 'RPC_PAYLOAD_TOO_LARGE' })
    const readTransfer = randomUUID()
    const bytes = Buffer.from(json)
    const timeout = setTimeout(() => this.#release(readTransfer), lifetimeMs).unref()
    this.#pending.set(readTransfer, { bytes, offset: 0, timeout })
    this.#bytes += byteLength
    return { readTransfer, byteLength }
  }

  read(params: unknown): string {
    const { readTransfer, offset } = requestSchema.parse(params)
    const entry = this.#pending.get(readTransfer)
    if (!entry || entry.offset !== offset)
      throw Object.assign(new Error('SOURCE_CHANGED'), { code: 'SOURCE_CHANGED' })
    const chunk = entry.bytes.subarray(offset, offset + partBytes)
    entry.offset += chunk.length
    if (entry.offset === entry.bytes.length)
      this.#release(readTransfer)
    else
      entry.timeout.refresh()
    return chunk.toString('base64')
  }

  release(params: unknown): null {
    this.#release(z.uuid().parse(params))
    return null
  }

  clear(): void {
    for (const id of this.#pending.keys())
      this.#release(id)
  }

  #release(id: string): void {
    const entry = this.#pending.get(id)
    if (entry) {
      clearTimeout(entry.timeout)
      this.#bytes -= entry.bytes.length
      this.#pending.delete(id)
    }
  }
}

export async function receiveServiceRead(
  value: unknown,
  read: (params: { readTransfer: string, offset: number }) => Promise<unknown>,
  release: (id: string) => void,
): Promise<unknown> {
  const parsed = descriptor.safeParse(value)
  if (!parsed.success)
    return value
  const { readTransfer, byteLength } = parsed.data
  const bytes = Buffer.allocUnsafe(byteLength)
  try {
    for (let offset = 0; offset < byteLength; offset += partBytes) {
      const part = await read({ readTransfer, offset })
      const length = Math.min(partBytes, byteLength - offset)
      if (typeof part !== 'string' || part.length !== Math.ceil(length / 3) * 4 || bytes.write(part, offset, length, 'base64') !== length)
        throw Object.assign(new Error('Invalid history transfer'), { code: 'RUNTIME_PROTOCOL_ERROR' })
    }
    return JSON.parse(bytes.toString('utf8'))
  }
  catch (error) {
    release(readTransfer)
    throw error
  }
}
