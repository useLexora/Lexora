import type { FileHandle } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { lstat, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileStorage } from '../filesystem/fileStorage'

async function fileIdentity(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (!stat.isFile())
      throw new Error('EXTENSION_RESOURCE_SAVE_TARGET_INVALID')
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw error
  }
}

export class ExtensionResourceWriter {
  readonly id = randomUUID()
  readonly #path: string
  readonly #temporary: string
  readonly #handle: FileHandle
  readonly #size: number
  readonly #identity: string | null
  readonly #parentIdentity: string
  readonly #assertCurrent: () => void
  #written = 0
  #closed = false
  #cancelled = false
  #committed = false
  #tail: Promise<unknown> = Promise.resolve()

  private constructor(path: string, temporary: string, handle: FileHandle, size: number, identity: string | null, parentIdentity: string, assertCurrent: () => void) {
    this.#path = path
    this.#temporary = temporary
    this.#handle = handle
    this.#size = size
    this.#identity = identity
    this.#parentIdentity = parentIdentity
    this.#assertCurrent = assertCurrent
  }

  static async create(path: string, size: number, assertCurrent: () => void): Promise<ExtensionResourceWriter> {
    const parent = await realpath(dirname(path))
    const canonical = join(parent, basename(path))
    const stat = await lstat(parent, { bigint: true })
    const identity = await fileIdentity(canonical)
    const temporary = join(parent, `.lexora-${randomUUID()}.tmp`)
    assertCurrent()
    const handle = await open(temporary, 'wx', 0o600)
    return new ExtensionResourceWriter(canonical, temporary, handle, size, identity, `${stat.dev}:${stat.ino}`, assertCurrent)
  }

  append(offset: number, base64: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assert()
      const data = Buffer.from(base64, 'base64')
      if (offset !== this.#written || !data.length || data.length > 96 * 1024 || this.#written + data.length > this.#size)
        throw new Error('EXTENSION_RESOURCE_WRITE_RANGE')
      await this.#handle.writeFile(data)
      this.#written += data.length
    })
  }

  commit(): Promise<void> {
    return this.#enqueue(async () => {
      this.#assert()
      if (this.#written !== this.#size)
        throw new Error('EXTENSION_RESOURCE_WRITE_INCOMPLETE')
      await this.#handle.sync()
      await this.#close()
      const parent = dirname(this.#path)
      const stat = await lstat(parent, { bigint: true })
      if (await realpath(parent) !== parent || `${stat.dev}:${stat.ino}` !== this.#parentIdentity || await fileIdentity(this.#path) !== this.#identity)
        throw new Error('EXTENSION_RESOURCE_SAVE_TARGET_CHANGED')
      this.#assert()
      await fileStorage.replace(this.#temporary, this.#path)
      this.#committed = true
      await fileStorage.syncDirectory(parent)
    })
  }

  dispose(): Promise<void> {
    this.#cancelled = true
    return this.#enqueue(async () => {
      await this.#close()
      if (!this.#committed)
        await rm(this.#temporary, { force: true })
    })
  }

  #assert(): void {
    if (this.#cancelled || this.#committed)
      throw new Error('EXTENSION_RESOURCE_WRITE_EXPIRED')
    this.#assertCurrent()
  }

  async #close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true
      await this.#handle.close()
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#tail.catch(() => {}).then(operation)
    this.#tail = task
    return task
  }
}
