import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface WebCacheReceipt {
  readonly path: string
  readonly bytes: number
  readonly cleanup: 'completed' | 'failed'
  readonly removed: number
}

export class WebContentCache {
  readonly #paths: BuddyDataPaths
  readonly #pending = new Map<string, Promise<unknown>>()
  #disposing: Promise<void> | undefined

  constructor(paths: BuddyDataPaths) { this.#paths = paths }

  write(conversationId: string, content: string, signal?: AbortSignal): Promise<WebCacheReceipt> {
    if (this.#disposing)
      return Promise.reject(new Error('WEB_CACHE_STOPPED'))
    const previous = this.#pending.get(conversationId) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted()
      const directory = join(this.#paths.conversationDirectory(conversationId), 'web-cache')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, `${randomUUID()}.txt`)
      signal?.throwIfAborted()
      try {
        await writeFile(path, content, { mode: 0o600, flag: 'wx' })
      }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
          await unlink(path).catch(() => {})
        throw error
      }
      let removed = 0
      let cleanup: WebCacheReceipt['cleanup'] = 'completed'
      try {
        const entries = await readdir(directory, { withFileTypes: true })
        const files = await Promise.all(entries.filter(entry => entry.isFile() && /^[\da-f-]{36}\.txt$/.test(entry.name)).map(async (entry) => {
          const filePath = join(directory, entry.name)
          return { path: filePath, mtime: (await stat(filePath)).mtimeMs }
        }))
        const expired = files.filter(file => file.path !== path).sort((a, b) => b.mtime - a.mtime).slice(31)
        const results = await Promise.allSettled(expired.map(file => unlink(file.path)))
        removed = results.filter(result => result.status === 'fulfilled').length
        if (removed !== results.length)
          cleanup = 'failed'
      }
      catch { cleanup = 'failed' }
      return { path, bytes: new TextEncoder().encode(content).byteLength, removed, cleanup }
    })
    this.#pending.set(conversationId, result)
    void result.finally(() => {
      if (this.#pending.get(conversationId) === result)
        this.#pending.delete(conversationId)
    }).catch(() => {})
    return result
  }

  dispose(): Promise<void> {
    this.#disposing ??= Promise.allSettled([...this.#pending.values()]).then(() => {})
    return this.#disposing
  }
}
