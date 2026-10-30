import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export type ImageReadingMaterialWriter = (text: string, signal?: AbortSignal) => Promise<string>

export class ImageReadingMaterialStore {
  readonly #scratchRoot: string
  readonly #conversationId: string

  constructor(scratchRoot: string, conversationId: string) {
    if (!/^[A-Z0-9][\w-]{0,127}$/i.test(conversationId))
      throw new Error('Invalid image reading material owner')
    this.#scratchRoot = scratchRoot
    this.#conversationId = conversationId
  }

  async write(text: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (await realpath(this.#scratchRoot) !== this.#scratchRoot)
      throw new Error('Image reading workspace identity changed')
    const root = join(this.#scratchRoot, '.image-reading')
    const directory = join(root, this.#conversationId)
    for (const path of [root, directory]) {
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST')
          throw error
      })
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path)
        throw new Error('Image reading material directory identity changed')
    }
    signal?.throwIfAborted()
    const path = join(directory, `${randomUUID()}.txt`)
    const file = await open(path, 'wx', 0o600)
    let identity: { dev: number, ino: number } | undefined
    try {
      identity = await file.stat()
      await file.writeFile(text, { encoding: 'utf8', signal })
      signal?.throwIfAborted()
      const current = await lstat(path)
      if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino || await realpath(path) !== path)
        throw new Error('Image reading material identity changed')
      return path
    }
    catch (error) {
      const current = await lstat(path).catch(() => null)
      if (identity && current?.isFile() && current.dev === identity.dev && current.ino === identity.ino && await realpath(directory) === directory)
        await unlink(path).catch(() => {})
      throw error
    }
    finally {
      await file.close()
    }
  }
}
