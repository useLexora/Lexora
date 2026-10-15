import type { ImageContent } from '@earendil-works/pi-ai'
import type { InputModel } from '../providers/modelCapabilities'
import type { AttachmentRecord } from '../storage/attachmentRepository'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { convertToPng, formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import { fileStorage } from '../../../platform/filesystem/fileStorage'
import { getModelImageResize } from '../providers/modelInputBudget'
import { conversationImageDirectory, imageBlobReferenceSchema, ImageBlobStore } from './ImageBlobStore'
import { validateResourceBytes } from './validateResourceBytes'

const MAX_CACHE_BYTES = 5 * 1024 * 1024
const imageMetadata = z.object({
  sourceHash: z.string().regex(/^[\da-f]{64}$/),
  mimeType: z.enum(['image/png', 'image/jpeg']),
  width: z.number().int().positive().max(2000),
  height: z.number().int().positive().max(2000),
  note: z.string().max(1024).optional(),
}).strict()
const legacyImageSchema = imageMetadata.extend({
  version: z.literal(1),
  dataHash: z.string().regex(/^[\da-f]{64}$/),
  data: z.string().min(1).max(4.5 * 1024 * 1024),
}).strict()
const imageSchema = imageMetadata.extend({ version: z.literal(2), blob: imageBlobReferenceSchema }).strict()
const cachedImageSchema = z.discriminatedUnion('version', [legacyImageSchema, imageSchema])

export interface PreparedAttachmentImage {
  image: ImageContent
  note?: string
}

export class AttachmentImageStore {
  readonly #pending = new Map<string, Promise<PreparedAttachmentImage | null>>()

  prepare(record: AttachmentRecord, bytes: Buffer, directory: string, model: InputModel): Promise<PreparedAttachmentImage | null> {
    const path = join(directory, `${record.id}.json`)
    const existing = this.#pending.get(path)
    if (existing)
      return existing.then(() => this.#prepare(record, bytes, directory, model))
    const pending = this.#prepare(record, bytes, directory, model).finally(() => this.#pending.delete(path))
    this.#pending.set(path, pending)
    return pending
  }

  async #prepare(record: AttachmentRecord, bytes: Buffer, directory: string, model: InputModel): Promise<PreparedAttachmentImage | null> {
    if (bytes.length !== record.sizeBytes)
      throw new Error('RESOURCE_MATERIALIZATION_FAILED')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(directory)).isDirectory())
      throw new Error('RESOURCE_MATERIALIZATION_FAILED')
    const path = join(directory, `${record.id}.json`)
    const blobs = new ImageBlobStore(conversationImageDirectory(dirname(directory)))
    const sourceHash = hash(bytes)
    let cached: z.infer<typeof cachedImageSchema>
    let changed = false
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.size > MAX_CACHE_BYTES)
        throw new Error('RESOURCE_MATERIALIZATION_FAILED')
      const parsed = cachedImageSchema.safeParse(JSON.parse((await readBoundedFile(directory, path, MAX_CACHE_BYTES)).toString('utf8')))
      if (!parsed.success)
        throw new Error('RESOURCE_MATERIALIZATION_FAILED')
      cached = parsed.data
      if (cached.sourceHash !== sourceHash || (cached.version === 1 && cached.dataHash !== hash(cached.data)))
        throw new Error('RESOURCE_MATERIALIZATION_FAILED')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
      await validateResourceBytes(record, bytes)
      const converted = ['image/png', 'image/jpeg'].includes(record.mimeType)
        ? { data: bytes.toString('base64'), mimeType: record.mimeType }
        : await convertToPng(bytes.toString('base64'), record.mimeType)
      if (!converted)
        throw new Error('RESOURCE_MATERIALIZATION_FAILED')
      const resized = await resizeImage(Buffer.from(converted.data, 'base64'), converted.mimeType, getModelImageResize(model))
      if (!resized)
        throw new Error('RESOURCE_MATERIALIZATION_FAILED')
      const note = [
        formatDimensionNote(resized),
        ['image/gif', 'image/webp'].includes(record.mimeType) ? 'Static image preview; animation is not supplied. Use the original file to inspect other frames.' : undefined,
      ].filter(Boolean).join(' ')
      cached = imageSchema.parse({
        version: 2,
        sourceHash,
        blob: await blobs.put(resized.data),
        mimeType: resized.mimeType,
        width: resized.width,
        height: resized.height,
        ...note ? { note } : {},
      })
      changed = true
    }
    if (cached.version === 1) {
      const { data, dataHash: _dataHash, version: _version, ...metadata } = cached
      cached = { ...metadata, version: 2, blob: await blobs.put(data) }
      changed = true
    }
    if (changed) {
      const temporary = `${path}.${randomUUID()}.part`
      try {
        await writeFile(temporary, JSON.stringify(cached), { flag: 'wx', mode: 0o600, flush: true })
        await fileStorage.replace(temporary, path)
        await fileStorage.syncDirectory(directory)
      }
      finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT')
            throw error
        })
      }
    }
    const data = (await blobs.read(cached.blob)).toString('base64')
    const limits = getModelImageResize(model)
    if (cached.width > limits.maxWidth || cached.height > limits.maxHeight || data.length > limits.maxBytes)
      return null
    return { image: { type: 'image', data, mimeType: cached.mimeType }, note: cached.note }
  }
}

function hash(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}
