import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import { fileStorage } from '../../../platform/filesystem/fileStorage'

export const MAX_IMAGE_BLOB_BYTES = 32 * 1024 * 1024
export const imageBlobReferenceSchema = z.object({
  sha256: z.string().regex(/^[\da-f]{64}$/),
  sizeBytes: z.number().int().positive().max(MAX_IMAGE_BLOB_BYTES),
}).strict()
export type ImageBlobReference = z.infer<typeof imageBlobReferenceSchema>

export function conversationImageDirectory(conversationDirectory: string): string {
  return join(conversationDirectory, 'media', 'images')
}

export class ImageBlobStore {
  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  async put(data: string): Promise<ImageBlobReference> {
    if (data.length > Math.ceil(MAX_IMAGE_BLOB_BYTES / 3) * 4)
      throw new Error('RESOURCE_MATERIALIZATION_FAILED')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, ''))
      throw new Error('RESOURCE_MATERIALIZATION_FAILED')
    const reference = imageBlobReferenceSchema.parse({ sha256: hash(bytes), sizeBytes: bytes.length })
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.#assertDirectory()
    const path = join(this.directory, reference.sha256)
    try {
      await lstat(path)
      await this.read(reference)
      return reference
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
    const temporary = join(this.directory, `${reference.sha256}.${randomUUID()}.part`)
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true })
      await fileStorage.replace(temporary, path)
      await fileStorage.syncDirectory(this.directory)
    }
    finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT')
          throw error
      })
    }
    return reference
  }

  async read(input: ImageBlobReference): Promise<Buffer> {
    const reference = imageBlobReferenceSchema.parse(input)
    await this.#assertDirectory()
    const path = join(this.directory, reference.sha256)
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.size !== reference.sizeBytes)
      throw new Error('RESOURCE_MATERIALIZATION_FAILED')
    const bytes = await readBoundedFile(this.directory, path, reference.sizeBytes)
    if (bytes.length !== reference.sizeBytes || hash(bytes) !== reference.sha256)
      throw new Error('RESOURCE_MATERIALIZATION_FAILED')
    return bytes
  }

  async #assertDirectory(): Promise<void> {
    if (!(await lstat(this.directory)).isDirectory() || await realpath(this.directory) !== resolve(this.directory))
      throw new Error('RESOURCE_MATERIALIZATION_FAILED')
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
