import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileResponse } from './fileResponse'
import { fileStorage } from './fileStorage'

export class FileAssetStore {
  readonly root: string
  constructor(root: string) { this.root = root }

  async put(body: ReadableStream<Uint8Array>, signal: AbortSignal, assertCurrent: () => void): Promise<{ key: string, size: number }> {
    await mkdir(this.root, { recursive: true })
    const temporary = join(this.root, `${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    const reader = body.getReader()
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    const hash = createHash('sha256')
    let size = 0
    try {
      signal.throwIfAborted()
      while (true) {
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        assertCurrent()
        if (done)
          break
        size += value.byteLength
        if (!Number.isSafeInteger(size))
          throw new Error('RESOURCE_FILE_SIZE_INVALID')
        hash.update(value)
        let offset = 0
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset)
          if (!bytesWritten)
            throw new Error('RESOURCE_FILE_WRITE_FAILED')
          offset += bytesWritten
        }
      }
      await handle.sync()
      await handle.close()
      signal.throwIfAborted()
      assertCurrent()
      const key = hash.digest('hex')
      await fileStorage.replace(temporary, this.path(key))
      await fileStorage.syncDirectory(this.root)
      return { key, size }
    }
    finally {
      signal.removeEventListener('abort', abort)
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      await handle.close().catch(() => {})
      await rm(temporary, { force: true })
    }
  }

  path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error('RESOURCE_ASSET_INVALID')
    return join(this.root, key)
  }

  async response(key: string, mimeType: string, request: Request, signal: AbortSignal, onClose: () => void = () => {}, abortCode = 'RESOURCE_CANCELLED'): Promise<Response> {
    const handle = await open(this.path(key), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || !Number.isSafeInteger(stat.size))
        throw new Error('RESOURCE_ASSET_INVALID')
      return await fileResponse(handle, stat.size, mimeType, request, signal, onClose, abortCode)
    }
    catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  async collect(retained: ReadonlySet<string>): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return []
      throw error
    })
    for (const entry of entries) {
      if (entry.isFile() && (/^[a-f0-9]{64}$/.test(entry.name) || /^[a-f0-9-]+\.tmp$/.test(entry.name)) && !retained.has(entry.name))
        await rm(join(this.root, entry.name), { force: true })
    }
  }
}
