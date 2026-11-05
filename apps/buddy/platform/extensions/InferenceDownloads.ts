import type { FileHandle } from 'node:fs/promises'
import type { InferencePrepare, InferenceResourceProgress } from '../../shared/extensions/extensionInference'
import type { FileAssetStore } from '../filesystem/FileAssetStore'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { assertFileSnapshot } from '../filesystem/fileResponse'
import { fileStorage } from '../filesystem/fileStorage'
import { readExtensionJson, writeExtensionJson } from './extensionFiles'

const checkpointSchema = z.object({
  version: z.literal(1),
  identity: z.string(),
  total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  etag: z.string().max(512).optional(),
}).strict()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
type Report = (bytes: number, total: number | null, phase: InferenceResourceProgress['phase'], resumedBytes: number, force?: boolean) => void

async function readHash(handle: FileHandle, path: string, current: () => void) {
  const stat = await handle.stat({ bigint: true })
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('EXTENSION_INFERENCE_RESOURCE_INVALID')
  const hash = createHash('sha256')
  const buffer = new Uint8Array(1024 * 1024)
  let size = 0
  while (size < Number(stat.size)) {
    current()
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(stat.size) - size), size)
    if (!bytesRead)
      throw new Error('EXTENSION_INFERENCE_RESOURCE_CHANGED')
    hash.update(buffer.subarray(0, bytesRead))
    size += bytesRead
  }
  await assertFileSnapshot(handle, path, stat)
  current()
  return { hash, size, stat }
}

function contentLength(response: Response): number | null {
  const value = response.headers.get('content-length')
  if (value === null)
    return null
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('EXTENSION_INFERENCE_DOWNLOAD_RANGE_INVALID')
  return Number(value)
}

function strongEtag(response: Response): string | undefined {
  const value = response.headers.get('etag')
  return value && value.length <= 512 && /^"[\x21\x23-\x7E]*"$/.test(value) ? value : undefined
}

export class InferenceDownloads {
  readonly #root: string
  readonly #plan: string
  constructor(root: string, input: InferencePrepare) {
    this.#root = InferenceDownloads.resourceDirectory(root, input.id)
    this.#plan = join(this.#root, digest(JSON.stringify(input)))
  }

  static resourceDirectory(root: string, id: string): string {
    return join(root, digest(id))
  }

  async complete(): Promise<void> {
    await rm(this.#plan, { recursive: true, force: true })
  }

  async download(
    file: { path: string, sha256: string, size?: number },
    assets: FileAssetStore,
    response: (headers: Record<string, string>) => Promise<Response>,
    signal: AbortSignal,
    current: () => void,
    report: Report,
  ): Promise<{ key: string, size: number }> {
    const ready = await open(assets.path(file.sha256), constants.O_RDONLY | noFollow).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return undefined
      throw error
    })
    if (ready) {
      try {
        const { hash, size } = await readHash(ready, assets.path(file.sha256), current)
        if (hash.digest('hex') !== file.sha256 || (file.size !== undefined && file.size !== size))
          throw new Error('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
        report(size, size, 'download', size)
        report(size, size, 'verify', size)
        return { key: file.sha256, size }
      }
      finally { await ready.close() }
    }

    await mkdir(this.#plan, { recursive: true })
    const base = join(this.#plan, digest(file.path))
    const path = `${base}.part`
    const metadata = `${base}.json`
    const identity = JSON.stringify(file)
    let checkpoint: z.infer<typeof checkpointSchema>
    try {
      checkpoint = checkpointSchema.parse(await readExtensionJson(metadata, 8192))
      if (checkpoint.identity !== identity || (file.size !== undefined && checkpoint.total !== null && checkpoint.total !== file.size)
        || (checkpoint.etag && !/^"[\x21\x23-\x7E]*"$/.test(checkpoint.etag))) {
        throw new Error('EXTENSION_INFERENCE_DOWNLOAD_CHECKPOINT_INVALID')
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code!))
        throw error
      await rm(path, { force: true })
      checkpoint = { version: 1, identity, total: file.size ?? null }
      await writeExtensionJson(metadata, checkpoint, current)
    }
    const handle = await open(path, constants.O_RDWR | constants.O_CREAT | noFollow, 0o600)
    let invalid = false
    let body: ReadableStream<Uint8Array> | null = null
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const abort = () => {
      void reader?.cancel(signal.reason).catch(() => {})
    }
    const fail = (code: string): never => {
      invalid = true
      throw new Error(code)
    }
    try {
      const initial = await readHash(handle, path, current)
      let { hash, size } = initial
      if (checkpoint.total !== null && size > checkpoint.total)
        fail('EXTENSION_INFERENCE_RESOURCE_LIMIT')
      let resumed = size
      if (!size || hash.copy().digest('hex') !== file.sha256 || (file.size !== undefined && size !== file.size)) {
        if (size > 0 && checkpoint.total === size)
          fail('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
        if (initial.stat.nlink !== 1n)
          fail('EXTENSION_INFERENCE_RESOURCE_CHANGED')
        report(size, checkpoint.total, 'connect', resumed)
        current()
        body = null
        const headers: Record<string, string> = { 'accept-encoding': 'identity' }
        if (size > 0) {
          headers.range = `bytes=${size}-`
          if (checkpoint.etag)
            headers['if-range'] = checkpoint.etag
        }
        const result = await response(headers).catch((cause: unknown) => {
          signal.throwIfAborted()
          if (cause instanceof Error && /^EXTENSION_[A-Z_]+$/.test(cause.message))
            throw cause
          throw new Error('EXTENSION_INFERENCE_DOWNLOAD_FAILED', { cause })
        })
        body = result.body
        current()
        if (result.status === 416)
          fail('EXTENSION_INFERENCE_DOWNLOAD_RANGE_INVALID')
        if (![200, 206].includes(result.status) || !body)
          throw new Error('EXTENSION_INFERENCE_DOWNLOAD_FAILED')
        let length: number | null
        try {
          length = contentLength(result)
        }
        catch (error) {
          invalid = true
          throw error
        }
        const encoding = result.headers.get('content-encoding')
        if (encoding && encoding.toLowerCase() !== 'identity')
          fail('EXTENSION_INFERENCE_DOWNLOAD_RANGE_INVALID')
        const etag = strongEtag(result)
        if (result.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.headers.get('content-range') ?? '')
          const [start, end, total] = range ? range.slice(1).map(Number) : []
          if (!size || !range || ![start, end, total].every(value => Number.isSafeInteger(value))
            || start !== size || total! <= size || end !== total! - 1
            || (length !== null && length !== total! - size)
            || (checkpoint.total !== null && checkpoint.total !== total)
            || (file.size !== undefined && file.size !== total)
            || (checkpoint.etag && result.headers.has('etag') && checkpoint.etag !== result.headers.get('etag'))) {
            fail('EXTENSION_INFERENCE_DOWNLOAD_RANGE_INVALID')
          }
          checkpoint.total = total!
          length = total! - size
        }
        else {
          if (result.headers.has('content-range'))
            fail('EXTENSION_INFERENCE_DOWNLOAD_RANGE_INVALID')
          if (file.size !== undefined && length !== null && file.size !== length)
            fail('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
          await handle.truncate(0)
          size = 0
          resumed = 0
          hash = createHash('sha256')
          checkpoint.total = file.size ?? length
        }
        checkpoint.etag = etag ?? (result.status === 206 ? checkpoint.etag : undefined)
        await writeExtensionJson(metadata, checkpoint, current)
        report(size, checkpoint.total, 'download', resumed)
        reader = body!.getReader()
        signal.addEventListener('abort', abort, { once: true })
        current()
        const start = size
        while (true) {
          const chunk = await reader.read().catch((cause: unknown) => {
            signal.throwIfAborted()
            throw new Error('EXTENSION_INFERENCE_DOWNLOAD_FAILED', { cause })
          })
          current()
          if (chunk.done)
            break
          const next = size + chunk.value.byteLength
          if (!Number.isSafeInteger(next) || (checkpoint.total !== null && next > checkpoint.total) || (length !== null && next - start > length))
            fail('EXTENSION_INFERENCE_RESOURCE_LIMIT')
          let offset = 0
          while (offset < chunk.value.byteLength) {
            current()
            const { bytesWritten } = await handle.write(chunk.value, offset, chunk.value.byteLength - offset, size)
            if (!bytesWritten)
              throw new Error('RESOURCE_FILE_WRITE_FAILED')
            hash.update(chunk.value.subarray(offset, offset + bytesWritten))
            size += bytesWritten
            offset += bytesWritten
          }
          report(size, checkpoint.total, 'download', resumed)
        }
        if ((length !== null && size - start !== length) || (checkpoint.total !== null && size !== checkpoint.total))
          fail('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
      }
      report(size, checkpoint.total, 'download', resumed, true)
      report(size, checkpoint.total, 'verify', resumed, true)
      if (hash.digest('hex') !== file.sha256 || (file.size !== undefined && size !== file.size))
        fail('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
      await handle.sync()
      const verify = async (target: string, fileHandle = handle) => {
        try {
          const verified = await readHash(fileHandle, target, current)
          if (verified.size !== size || verified.hash.digest('hex') !== file.sha256)
            fail('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
        }
        catch (error) {
          if (!signal.aborted)
            invalid = true
          throw error
        }
      }
      await verify(path)
      current()
      await mkdir(assets.root, { recursive: true })
      const destination = assets.path(file.sha256)
      let linked = false
      try {
        await link(path, destination)
        linked = true
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw error
        const existing = await open(destination, constants.O_RDONLY | noFollow)
        try {
          await verify(destination, existing)
        }
        finally { await existing.close() }
      }
      if (linked)
        await verify(destination)
      await fileStorage.syncDirectory(assets.root)
      current()
      return { key: file.sha256, size }
    }
    finally {
      signal.removeEventListener('abort', abort)
      if (reader) {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      else { await body?.cancel().catch(() => {}) }
      await handle.close().catch(() => {})
      if (invalid) {
        await rm(path, { force: true })
        await rm(metadata, { force: true })
      }
    }
  }
}
