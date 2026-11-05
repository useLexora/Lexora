import type { BigIntStats } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertFileSnapshot, fileResponse } from './fileResponse'
import { fileStorage } from './fileStorage'

export class FileAssetStore {
  readonly root: string
  constructor(root: string) { this.root = root }

  async put(body: ReadableStream<Uint8Array>, signal: AbortSignal, assertCurrent: () => void, onProgress?: (bytes: number) => void): Promise<{ key: string, size: number }> {
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
        onProgress?.(size)
      }
      await handle.sync()
      await handle.close()
      signal.throwIfAborted()
      assertCurrent()
      const key = hash.digest('hex')
      try {
        await link(temporary, this.path(key))
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw error
        await this.#verifyExisting(key, size, signal, assertCurrent)
      }
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

  async #verifyExisting(key: string, size: number, signal: AbortSignal, assertCurrent: () => void): Promise<void> {
    const path = this.path(key)
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.size !== BigInt(size))
      throw new Error('RESOURCE_ASSET_INVALID')
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const buffer = new Uint8Array(64 * 1024)
      let snapshot = before
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await assertFileSnapshot(handle, path, snapshot)
          const hash = createHash('sha256')
          let position = 0
          while (position < size) {
            signal.throwIfAborted()
            assertCurrent()
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position)
            if (!bytesRead)
              throw new Error('RESOURCE_FILE_CHANGED')
            hash.update(buffer.subarray(0, bytesRead))
            position += bytesRead
          }
          await assertFileSnapshot(handle, path, snapshot)
          signal.throwIfAborted()
          assertCurrent()
          if (hash.digest('hex') !== key)
            throw new Error('RESOURCE_ASSET_INVALID')
          return
        }
        catch (error) {
          if (attempt || !(error instanceof Error) || error.message !== 'RESOURCE_FILE_CHANGED')
            throw error
          const latest = await handle.stat({ bigint: true })
          for (const after of [latest, await lstat(path, { bigint: true })]) {
            if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs)
              throw error
          }
          snapshot = latest
        }
      }
    }
    finally { await handle.close() }
  }

  path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error('RESOURCE_ASSET_INVALID')
    return join(this.root, key)
  }

  async response(key: string, mimeType: string, request: Request, signal: AbortSignal, onClose: () => void = () => {}, abortCode = 'RESOURCE_CANCELLED', verifySnapshot = false): Promise<Response> {
    const path = this.path(key)
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let stat: BigIntStats
    try {
      stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || !Number.isSafeInteger(Number(stat.size)))
        throw new Error('RESOURCE_ASSET_INVALID')
    }
    catch (error) {
      await handle.close()
      throw error
    }
    return fileResponse(handle, Number(stat.size), mimeType, request, signal, onClose, abortCode, verifySnapshot ? () => assertFileSnapshot(handle, path, stat) : undefined)
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
