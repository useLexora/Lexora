import type { FileHandle } from 'node:fs/promises'
import type { InferencePrepare, InferenceResourceProgress, InferenceResourceSet } from '../../shared/extensions/extensionInference'
import type { InferencePreparationRunner } from './inferencePreparation'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { inferenceHashSchema, inferenceIdSchema, inferencePrepareSchema, inferenceResourcePathSchema, inferenceResourceSetSchema } from '../../shared/extensions/extensionInference'
import { extensionIdSchema } from '../../shared/extensions/extensionManifest'
import { FileAssetStore } from '../filesystem/FileAssetStore'
import { EXTENSION_FILE_LIMIT, readExtensionJson, writeExtensionJson } from './extensionFiles'
import { InferenceDownloads } from './InferenceDownloads'
import { collectInferencePreparation } from './inferencePreparation'

const fileSchema = z.object({
  path: inferenceResourcePathSchema,
  sha256: inferenceHashSchema,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  executable: z.boolean().optional(),
  resourceId: z.uuid().optional(),
  directoryReference: z.object({ directoryId: z.uuid(), path: inferenceResourcePathSchema }).strict().optional(),
}).strict()
const setSchema = inferenceResourceSetSchema.extend({ entries: z.array(fileSchema).min(1).max(4096) }).strict()
const indexSchema = z.object({ version: z.literal(1), sets: z.array(setSchema).max(128) }).strict()
type ResourceSet = z.infer<typeof setSchema>
export interface InferenceResourceLease {
  files: Array<{
    path: string
    handle: FileHandle
    hostPath?: string
  }>
  directory?: string
  release: () => Promise<void>
}
export interface InferenceResourceSource {
  prepare?: InferencePreparationRunner
  assertDownload?: (url: string) => void
  response: (source: InferencePrepare['files'][number]['source'] | { resourceId: string }, signal: AbortSignal, headers?: Record<string, string>) => Promise<Response>
  openReference: (resourceId: string) => Promise<FileHandle>
  openDirectoryReference?: (input: { directoryId: string, path: string }) => Promise<FileHandle>
  referencePath?: (resourceId: string) => Promise<string>
  directoryReferencePath?: (input: { directoryId: string, path: string }) => Promise<string>
}

export async function verifyInferenceResourcePath(file: InferenceResourceLease['files'][number]): Promise<string> {
  if (!file.hostPath)
    throw new Error('EXTENSION_INFERENCE_RESOURCE_PATH_UNAVAILABLE')
  const before = await file.handle.stat({ bigint: true })
  const after = await lstat(file.hostPath, { bigint: true })
  if (!before.isFile() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs)
    throw new Error('EXTENSION_INFERENCE_RESOURCE_CHANGED')
  return file.hostPath
}

export class ExtensionInferenceResources {
  readonly #root: string
  readonly #writes = new Map<string, Promise<unknown>>()
  readonly #preparing = new Map<string, number>()
  readonly #activeResources = new Set<string>()
  readonly #leases = new Map<string, number>()
  constructor(root: string) {
    this.#root = root
  }

  async list(id: string): Promise<InferenceResourceSet[]> {
    return (await this.#read(id)).sets.map(({ entries: _entries, ...set }) => set)
  }

  async available(id: string, files: ReadonlySet<string>, directories: ReadonlySet<string>): Promise<InferenceResourceSet[]> {
    return (await this.inspect(id, files, directories)).filter(set => set.authorized).map(({ authorized: _authorized, ...set }) => set)
  }

  async inspect(id: string, files: ReadonlySet<string>, directories: ReadonlySet<string>): Promise<Array<InferenceResourceSet & { authorized: boolean }>> {
    return (await this.#read(id)).sets.map(({ entries, ...set }) => ({
      ...set,
      authorized: entries.every(file => (!file.resourceId || files.has(file.resourceId)) && (!file.directoryReference || directories.has(file.directoryReference.directoryId))),
    }))
  }

  async prepare(id: string, input: InferencePrepare, source: InferenceResourceSource, signal: AbortSignal, assertCurrent: () => void, onProgress?: (progress: InferenceResourceProgress) => void): Promise<InferenceResourceSet> {
    input = inferencePrepareSchema.parse(input)
    if (input.preparation && !source.prepare)
      throw new Error('EXTENSION_INFERENCE_PREPARATION_UNAVAILABLE')
    const files = this.#files(id)
    const downloads = new InferenceDownloads(join(this.#directory(id), 'downloads'), input)
    const activeKey = `${id}:${input.id}`
    const current = () => {
      signal.throwIfAborted()
      assertCurrent()
    }
    await this.#mutate(id, async () => {
      current()
      if (this.#activeResources.has(activeKey))
        throw new Error('EXTENSION_INFERENCE_RESOURCE_BUSY')
      this.#activeResources.add(activeKey)
      this.#preparing.set(id, (this.#preparing.get(id) ?? 0) + 1)
    })
    try {
      const entries: ResourceSet['entries'] = []
      let lastProgress = ''
      let reportedAt = 0
      const report = (path: string, bytes: number, totalBytes: number | null, phase: InferenceResourceProgress['phase'], completedFiles = entries.length, force = false, resumedBytes?: number) => {
        const key = `${phase}:${path}:${completedFiles}`
        const now = Date.now()
        if (force || key !== lastProgress || now - reportedAt >= 200 || bytes === totalBytes) {
          lastProgress = key
          reportedAt = now
          onProgress?.({ resource: input.id, path, phase, completedFiles, totalFiles: phase === 'ready' ? entries.length : input.files.length, bytes, totalBytes, ...(resumedBytes === undefined ? {} : { resumedBytes }) })
        }
      }
      const download = async (from: Parameters<InferenceResourceSource['response']>[0], path: string, sha256: string, expectedSize?: number) => {
        current()
        if ('url' in from) {
          source.assertDownload?.(from.url)
          return downloads.download({ path, sha256, size: expectedSize }, files, headers => source.response(from, signal, headers), signal, current, (bytes, total, phase, resumedBytes, force) => {
            report(path, bytes, total, phase, entries.length, force, resumedBytes)
          })
        }
        const response = await source.response(from, signal)
        if (!response.ok || !response.body) {
          await response.body?.cancel()
          throw new Error('EXTENSION_INFERENCE_DOWNLOAD_FAILED')
        }
        const header = response.headers.get('content-length')
        const length = header !== null && /^\d+$/.test(header) ? Number(header) : null
        const total = expectedSize ?? (length !== null && Number.isSafeInteger(length) ? length : null)
        report(path, 0, total, 'download')
        const asset = await files.put(response.body, signal, current, (bytes) => {
          const oversized = expectedSize !== undefined && bytes > expectedSize
          report(path, bytes, total, 'download', entries.length, oversized)
          if (oversized)
            throw new Error('EXTENSION_INFERENCE_RESOURCE_LIMIT')
        })
        report(path, asset.size, total, 'download', entries.length, true)
        report(path, asset.size, total, 'verify')
        if (asset.key !== sha256 || (expectedSize !== undefined && asset.size !== expectedSize))
          throw new Error('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
        return asset
      }
      if (input.preparation) {
        const handles: Parameters<InferencePreparationRunner>[0] = []
        try {
          for (const resource of input.preparation.inputs) {
            const asset = await download(resource.source, resource.id, resource.sha256, resource.size)
            const handle = await open(files.path(asset.key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
            handles.push({ path: resource.id, handle, hostPath: files.path(asset.key) })
          }
          entries.push(...await collectInferencePreparation(input, handles, source.prepare!, files, signal, current, report))
        }
        finally { await Promise.all(handles.map(file => file.handle.close())) }
      }
      for (const file of input.files) {
        current()
        if ('directoryId' in file.source) {
          if (!source.openDirectoryReference)
            throw new Error('EXTENSION_INFERENCE_RESOURCE_UNAVAILABLE')
          const directoryReference = { directoryId: file.source.directoryId, path: file.source.path }
          const handle = await source.openDirectoryReference(directoryReference)
          try {
            const size = await this.#verify(handle, file.sha256, signal, (bytes, total) => report(file.path, bytes, total, 'verify'))
            entries.push({ path: file.path, sha256: file.sha256, size, directoryReference })
          }
          finally { await handle.close() }
        }
        else if ('resourceId' in file.source && file.source.reference) {
          const handle = await source.openReference(file.source.resourceId)
          try {
            const size = await this.#verify(handle, file.sha256, signal, (bytes, total) => report(file.path, bytes, total, 'verify'))
            entries.push({ path: file.path, sha256: file.sha256, size, resourceId: file.source.resourceId })
          }
          finally {
            await handle.close()
          }
        }
        else {
          const asset = await download(file.source, file.path, file.sha256, file.size)
          entries.push({ path: file.path, sha256: asset.key, size: asset.size })
        }
        if (file.executable) {
          const entry = entries.at(-1)!
          entry.executable = true
          if (process.platform !== 'win32' && !entry.resourceId && !entry.directoryReference) {
            const handle = await open(files.path(entry.sha256), constants.O_RDONLY | constants.O_NOFOLLOW)
            try {
              await handle.chmod(0o700)
            }
            finally {
              await handle.close()
            }
          }
        }
        const entry = entries.at(-1)!
        if (file.size !== undefined && entry.size !== file.size)
          throw new Error('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
        report(file.path, entry.size, entry.size, 'verify')
      }
      entries.sort((a, b) => a.path.localeCompare(b.path))
      const revision = createHash('sha256').update(JSON.stringify({ kind: input.kind, entries })).digest('hex')
      const prepared = setSchema.parse({ id: input.id, revision, kind: input.kind, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), entries })
      await this.#mutate(id, async () => {
        current()
        const index = await this.#read(id)
        const retained = index.sets.filter(set => set.id !== prepared.id || set.revision !== prepared.revision)
        const next = indexSchema.parse({ version: 1, sets: [...retained, prepared] })
        if (Buffer.byteLength(JSON.stringify(next)) > EXTENSION_FILE_LIMIT)
          throw new Error('EXTENSION_INFERENCE_RESOURCE_LIMIT')
        await writeExtensionJson(this.#indexPath(id), next, current)
      })
      await downloads.complete()
      const { entries: _entries, ...result } = prepared
      report('', prepared.bytes, prepared.bytes, 'ready')
      return result
    }
    finally {
      await this.#mutate(id, async () => {
        this.#activeResources.delete(activeKey)
        const remaining = this.#preparing.get(id)! - 1
        if (remaining)
          this.#preparing.set(id, remaining)
        else
          this.#preparing.delete(id)
        await this.#collect(id)
      })
    }
  }

  async acquire(id: string, resource: {
    id: string
    revision: string
  }, source: InferenceResourceSource, signal: AbortSignal): Promise<InferenceResourceLease> {
    inferenceIdSchema.parse(resource.id)
    inferenceHashSchema.parse(resource.revision)
    const key = this.#leaseKey(id, resource.id, resource.revision)
    const set = await this.#mutate(id, async () => {
      signal.throwIfAborted()
      const set = (await this.#read(id)).sets.find(set => set.id === resource.id && set.revision === resource.revision)
      if (!set)
        throw new Error('EXTENSION_INFERENCE_RESOURCE_UNAVAILABLE')
      this.#leases.set(key, (this.#leases.get(key) ?? 0) + 1)
      return set
    })
    const handles: InferenceResourceLease['files'] = []
    let directory: string | undefined
    let released = false
    const release = async () => {
      if (released)
        return
      released = true
      const results = await Promise.allSettled(handles.map(file => file.handle.close()))
      if (directory)
        results.push(...await Promise.allSettled([rm(directory, { recursive: true, force: true })]))
      const remaining = this.#leases.get(key)! - 1
      if (remaining)
        this.#leases.set(key, remaining)
      else
        this.#leases.delete(key)
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected')
        throw failed.reason
    }
    try {
      if (process.platform === 'win32' || process.platform === 'darwin')
        directory = await mkdtemp(join(this.#directory(id), 'view-'))
      for (const file of set.entries) {
        signal.throwIfAborted()
        if (file.directoryReference && !source.openDirectoryReference)
          throw new Error('EXTENSION_INFERENCE_RESOURCE_UNAVAILABLE')
        const handle = file.directoryReference
          ? await source.openDirectoryReference!(file.directoryReference)
          : file.resourceId
            ? await source.openReference(file.resourceId)
            : await open(this.#files(id).path(file.sha256), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const acquired: InferenceResourceLease['files'][number] = { path: file.path, handle }
        handles.push(acquired)
        const size = await this.#verify(handle, file.sha256, signal)
        if (size !== file.size)
          throw new Error('EXTENSION_INFERENCE_RESOURCE_CHANGED')
        if (directory) {
          const sourcePath = file.directoryReference
            ? await source.directoryReferencePath?.(file.directoryReference)
            : file.resourceId
              ? await source.referencePath?.(file.resourceId)
              : this.#files(id).path(file.sha256)
          acquired.hostPath = sourcePath
          await verifyInferenceResourcePath(acquired)
          if (!file.resourceId && !file.directoryReference) {
            const target = join(directory, file.path)
            await mkdir(dirname(target), { recursive: true })
            await link(sourcePath!, target)
            acquired.hostPath = target
            await verifyInferenceResourcePath(acquired)
          }
        }
        if (file.executable && process.platform !== 'win32') {
          if (!file.resourceId && !file.directoryReference)
            await handle.chmod(0o700)
          else if (!((await handle.stat()).mode & 0o100))
            throw new Error('EXTENSION_INFERENCE_RESOURCE_NOT_EXECUTABLE')
        }
      }
      signal.throwIfAborted()
      return { files: handles, directory, release }
    }
    catch (error) {
      await release()
      if (error instanceof Error) {
        if (/^EXTENSION_RESOURCE_(?:DIRECTORY_)?CHANGED$/.test(error.message))
          throw new Error('EXTENSION_INFERENCE_RESOURCE_CHANGED', { cause: error })
        if (/^EXTENSION_RESOURCE_(?:DIRECTORY_)?UNAVAILABLE$/.test(error.message) || ['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw new Error('EXTENSION_INFERENCE_RESOURCE_UNAVAILABLE', { cause: error })
      }
      throw error
    }
  }

  remove(id: string, resource: {
    id: string
    revision: string
  }, assertCurrent: () => void): Promise<void> {
    return this.#mutate(id, async () => {
      if (this.#activeResources.has(`${id}:${resource.id}`) || this.#leases.has(this.#leaseKey(id, resource.id, resource.revision)))
        throw new Error('EXTENSION_INFERENCE_RESOURCE_BUSY')
      const index = await this.#read(id)
      await writeExtensionJson(this.#indexPath(id), { version: 1, sets: index.sets.filter(set => set.id !== resource.id || set.revision !== resource.revision) }, assertCurrent)
      await rm(InferenceDownloads.resourceDirectory(join(this.#directory(id), 'downloads'), resource.id), { recursive: true, force: true })
      await this.#collect(id)
    })
  }

  async clear(id: string): Promise<void> {
    await this.#mutate(id, async () => {
      if (this.#preparing.get(id) || [...this.#leases.keys()].some(key => key.startsWith(`${id}:`)))
        throw new Error('EXTENSION_INFERENCE_RESOURCE_BUSY')
      await rm(this.#directory(id), { recursive: true, force: true })
    })
  }

  async drain(): Promise<void> {
    await Promise.all([...this.#writes.values()])
    if ([...this.#preparing.values()].some(Boolean) || this.#leases.size)
      throw new Error('EXTENSION_INFERENCE_RESOURCE_BUSY')
  }

  async #verify(handle: FileHandle, expected: string, signal: AbortSignal, onProgress?: (bytes: number, total: number) => void): Promise<number> {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('EXTENSION_INFERENCE_RESOURCE_INVALID')
    const hash = createHash('sha256')
    const buffer = new Uint8Array(1024 * 1024)
    let position = 0
    onProgress?.(0, Number(before.size))
    while (true) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead)
        break
      position += bytesRead
      hash.update(buffer.subarray(0, bytesRead))
      onProgress?.(position, Number(before.size))
    }
    const after = await handle.stat({ bigint: true })
    signal.throwIfAborted()
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || hash.digest('hex') !== expected)
      throw new Error('EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
    return position
  }

  #mutate<T>(id: string, operation: () => Promise<T>): Promise<T> {
    extensionIdSchema.parse(id)
    const pending = (this.#writes.get(id) ?? Promise.resolve()).catch(() => {
    }).then(operation)
    this.#writes.set(id, pending)
    void pending.finally(() => {
      if (this.#writes.get(id) === pending)
        this.#writes.delete(id)
    }).catch(() => {
    })
    return pending
  }

  async #collect(id: string): Promise<void> {
    if (this.#preparing.get(id))
      return
    const keys = new Set((await this.#read(id)).sets.flatMap(set => set.entries.filter(file => !file.resourceId && !file.directoryReference).map(file => file.sha256)))
    await this.#files(id).collect(keys)
  }

  #leaseKey(id: string, name: string, revision: string) {
    return `${extensionIdSchema.parse(id)}:${inferenceIdSchema.parse(name)}:${inferenceHashSchema.parse(revision)}`
  }

  #directory(id: string) {
    return join(this.#root, 'inference', extensionIdSchema.parse(id))
  }

  #indexPath(id: string) {
    return join(this.#directory(id), 'resources.json')
  }

  #files(id: string) {
    return new FileAssetStore(join(this.#directory(id), 'files'))
  }

  async #read(id: string): Promise<z.infer<typeof indexSchema>> {
    try {
      return indexSchema.parse(await readExtensionJson(this.#indexPath(id)))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, sets: [] }
      throw new Error('EXTENSION_INFERENCE_RESOURCE_REGISTRY_UNREADABLE')
    }
  }
}
