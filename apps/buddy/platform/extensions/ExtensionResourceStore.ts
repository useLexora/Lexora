import type { BigIntStats } from 'node:fs'
import type { ExtensionDirectoryScan, ExtensionLocalDirectory, ExtensionLocalFile, ExtensionResourceCreate } from '../../shared/extensions/extensionResources'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { z } from 'zod'
import { extensionIdSchema } from '../../shared/extensions/extensionManifest'
import { EXTENSION_CREATED_FILES_LIMIT, EXTENSION_CREATED_STORAGE_LIMIT, extensionLocalDirectorySchema, extensionLocalFileSchema, extensionResourceCreateSchema, extensionResourceMimeType } from '../../shared/extensions/extensionResources'
import { FileAssetStore } from '../filesystem/FileAssetStore'
import { containsCanonicalPath } from '../filesystem/filePaths'
import { fileResponse } from '../filesystem/fileResponse'
import { readExtensionJson, writeExtensionJson } from './extensionFiles'
import { ExtensionResourceUpload } from './ExtensionResourceUpload'

const grantSchema = z.object({
  resource: extensionLocalFileSchema,
  path: z.string().min(1).max(32768),
  identity: z.object({ device: z.string(), inode: z.string(), size: z.string(), modified: z.string() }).strict(),
  directoryId: z.string().uuid().optional(),
}).strict()
type Grant = z.infer<typeof grantSchema>
const ownedSchema = z.array(z.object({ resource: extensionLocalFileSchema, key: z.string().regex(/^[a-f0-9]{64}$/), generated: z.literal(true).optional() }).strict())
type Owned = z.infer<typeof ownedSchema>
const grantsSchema = z.array(grantSchema).max(1000)
const directorySchema = z.object({ resource: extensionLocalDirectorySchema, path: z.string().min(1).max(32768), device: z.string(), inode: z.string() }).strict()
type DirectoryGrant = z.infer<typeof directorySchema>
const directoriesSchema = z.array(directorySchema).max(32)
function identity(stat: BigIntStats): Grant['identity'] {
  return { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), modified: String(stat.mtimeNs) }
}

export class ExtensionResourceStore {
  readonly #root: string
  readonly #writes = new Map<string, Promise<unknown>>()
  readonly #imports = new Map<string, number>()
  readonly #creating = new Map<string, Map<string, number>>()
  readonly #streams = new Map<string, Set<AbortController>>()
  constructor(root: string) { this.#root = root }

  async list(id: string, allowLocal = true): Promise<ExtensionLocalFile[]> {
    const owned = (await this.#owned(id)).map(item => item.resource)
    if (!allowLocal)
      return owned
    const directories = await this.#directories(id)
    return [...owned, ...(await this.#read(id)).filter(grant => !grant.directoryId || directories.some(directory => directory.resource.id === grant.directoryId)).map(grant => grant.resource)]
  }

  grant(id: string, paths: string[], assertCurrent: () => void): Promise<ExtensionLocalFile[]> {
    return this.#mutate(id, async () => {
      if (paths.length > 100)
        throw new Error('EXTENSION_RESOURCE_SELECTION_LIMIT')
      const grants = await this.#read(id)
      const selected = await this.#select(paths, grants, assertCurrent)
      await writeExtensionJson(this.#path(id), grantsSchema.parse(grants), assertCurrent)
      return selected
    })
  }

  async #select(paths: string[], grants: Grant[], assertCurrent: () => void, directory?: DirectoryGrant): Promise<ExtensionLocalFile[]> {
    const selected: ExtensionLocalFile[] = []
    for (const path of new Set(paths)) {
      assertCurrent()
      const canonical = await realpath(path)
      if (directory && !containsCanonicalPath(directory.path, canonical))
        throw new Error('EXTENSION_RESOURCE_DIRECTORY_CHANGED')
      const mimeType = extensionResourceMimeType(extname(canonical).slice(1))
      const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const stat = await handle.stat({ bigint: true })
        if (!stat.isFile())
          throw new Error('EXTENSION_RESOURCE_UNSUPPORTED')
        const fingerprint = identity(stat)
        const existing = grants.find(grant => grant.path === canonical && grant.directoryId === directory?.resource.id && JSON.stringify(grant.identity) === JSON.stringify(fingerprint))
        const resource = existing?.resource ?? extensionLocalFileSchema.parse({ id: randomUUID(), name: basename(canonical), mimeType, size: Number(stat.size), ...(directory ? { relativePath: relative(directory.path, canonical).replaceAll('\\', '/') } : {}) })
        if (!existing)
          grants.push({ resource, path: canonical, identity: fingerprint, ...(directory ? { directoryId: directory.resource.id } : {}) })
        selected.push(resource)
      }
      finally { await handle.close() }
    }
    return selected
  }

  async directories(id: string): Promise<ExtensionLocalDirectory[]> {
    return (await this.#directories(id)).map(directory => directory.resource)
  }

  grantDirectory(id: string, path: string, assertCurrent: () => void): Promise<ExtensionLocalDirectory> {
    return this.#mutate(id, async () => {
      const canonical = await realpath(path)
      const stat = await lstat(canonical, { bigint: true })
      if (!stat.isDirectory())
        throw new Error('EXTENSION_RESOURCE_DIRECTORY_UNAVAILABLE')
      const directories = await this.#directories(id)
      const existing = directories.find(directory => directory.path === canonical && directory.device === String(stat.dev) && directory.inode === String(stat.ino))
      const resource = existing?.resource ?? extensionLocalDirectorySchema.parse({ id: randomUUID(), name: basename(canonical) })
      if (!existing)
        directories.push({ resource, path: canonical, device: String(stat.dev), inode: String(stat.ino) })
      await writeExtensionJson(this.#directoryPath(id), directoriesSchema.parse(directories), assertCurrent)
      return resource
    })
  }

  scanDirectory(id: string, options: ExtensionDirectoryScan, assertCurrent: () => void): Promise<ExtensionLocalFile[]> {
    return this.#mutate(id, async () => {
      const directoryId = options.id
      const extensions = new Set(options.extensions.map(extension => extension.toLowerCase()))
      const directory = (await this.#directories(id)).find(directory => directory.resource.id === directoryId)
      await this.#assertDirectory(directory)
      const paths: string[] = []
      let visited = 0
      const scan = async (path: string, depth: number) => {
        assertCurrent()
        if (depth > 16 || !containsCanonicalPath(directory!.path, await realpath(path)))
          throw new Error('EXTENSION_RESOURCE_DIRECTORY_LIMIT')
        for await (const entry of await opendir(path)) {
          assertCurrent()
          if (++visited > 10000 || paths.length > 1000)
            throw new Error('EXTENSION_RESOURCE_DIRECTORY_LIMIT')
          if (entry.isSymbolicLink())
            continue
          const child = join(path, entry.name)
          if (entry.isDirectory() && options.recursive)
            await scan(child, depth + 1)
          else if (entry.isFile() && (!extensions.size || extensions.has('*') || extensions.has(extname(entry.name).slice(1).toLowerCase())))
            paths.push(child)
        }
      }
      await scan(directory!.path, 0)
      const grants = await this.#read(id)
      const selected = await this.#select(paths.sort((a, b) => a.localeCompare(b)), grants, assertCurrent, directory)
      const selectedIds = new Set(selected.map(resource => resource.id))
      const retained = grants.filter((grant) => {
        if (grant.directoryId !== directoryId || selectedIds.has(grant.resource.id))
          return true
        const matchesExtension = !extensions.size || extensions.has('*') || extensions.has(extname(grant.path).slice(1).toLowerCase())
        const matchesDepth = options.recursive || !relative(directory!.path, grant.path).replaceAll('\\', '/').includes('/')
        return !matchesExtension || !matchesDepth
      })
      await this.#assertDirectory(directory)
      await writeExtensionJson(this.#path(id), grantsSchema.parse(retained), assertCurrent)
      for (const grant of grants) {
        if (!retained.includes(grant))
          this.#abort(id, grant.resource.id)
      }
      return selected
    })
  }

  revokeDirectory(id: string, directoryId: string, assertCurrent: () => void): Promise<void> {
    return this.#mutate(id, async () => {
      const directories = await this.#directories(id)
      await writeExtensionJson(this.#directoryPath(id), directories.filter(directory => directory.resource.id !== directoryId), assertCurrent)
      const grants = await this.#read(id)
      for (const grant of grants) {
        if (grant.directoryId === directoryId)
          this.#abort(id, grant.resource.id)
      }
      await writeExtensionJson(this.#path(id), grants.filter(grant => grant.directoryId !== directoryId), assertCurrent)
    })
  }

  revoke(id: string, resourceId?: string, assertCurrent: () => void = () => {}): Promise<void> {
    return this.#mutate(id, async () => {
      if (resourceId)
        z.string().uuid().parse(resourceId)
      const grants = await this.#read(id)
      if (!resourceId)
        await writeExtensionJson(this.#directoryPath(id), [], assertCurrent)
      await writeExtensionJson(this.#path(id), grants.filter(grant => resourceId && grant.resource.id !== resourceId), assertCurrent)
      for (const grant of grants) {
        if (!resourceId || grant.resource.id === resourceId) {
          this.#abort(id, grant.resource.id)
        }
      }
    })
  }

  async readBytes(id: string, resourceId: string, offset: number, length: number, signal: AbortSignal, allowLocal = true): Promise<{ base64: string, size: number, eof: boolean }> {
    const url = 'https://resource.invalid/'
    const metadata = await this.response(id, resourceId, new Request(url, { method: 'HEAD' }), signal, allowLocal)
    const size = Number(metadata.headers.get('content-length'))
    if (offset >= size)
      return { base64: '', size, eof: true }
    const response = await this.response(id, resourceId, new Request(url, { headers: { range: `bytes=${offset}-${offset + length - 1}` } }), signal, allowLocal)
    const bytes = Buffer.from(await response.arrayBuffer())
    return { base64: bytes.toString('base64'), size, eof: offset + bytes.length >= size }
  }

  async readText(id: string, resourceId: string, signal: AbortSignal, allowLocal = true): Promise<string> {
    const size = (await this.list(id, allowLocal)).find(resource => resource.id === resourceId)?.size
    if (size === undefined || size > 1024 * 1024)
      throw new Error('EXTENSION_RESOURCE_TEXT_LIMIT')
    const response = await this.response(id, resourceId, new Request('https://resource.invalid/'), signal, allowLocal)
    return response.text()
  }

  async create(id: string, input: ExtensionResourceCreate, signal: AbortSignal, assertCurrent: () => void): Promise<ExtensionResourceUpload> {
    const { name, mimeType, size } = extensionResourceCreateSchema.parse(input)
    const reservation = randomUUID()
    await this.#mutate(id, async () => {
      signal.throwIfAborted()
      assertCurrent()
      const creating = this.#creating.get(id) ?? new Map<string, number>()
      this.#assertCreationBudget(id, size, await this.#owned(id))
      creating.set(reservation, size)
      this.#creating.set(id, creating)
    })
    const upload = new ExtensionResourceUpload(size, async (body, transferSignal) => {
      try {
        return await this.import(id, name, mimeType, new Response(body), AbortSignal.any([signal, transferSignal]), assertCurrent, true)
      }
      finally {
        await this.#mutate(id, async () => {
          const creating = this.#creating.get(id)!
          creating.delete(reservation)
          if (!creating.size)
            this.#creating.delete(id)
        })
      }
    }, () => {
      signal.throwIfAborted()
      assertCurrent()
    })
    const abort = () => {
      void upload.dispose()
    }
    signal.addEventListener('abort', abort, { once: true })
    void upload.finished.finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
    if (signal.aborted)
      abort()
    return upload
  }

  copy(id: string, resourceId: string, name: string | undefined, assertCurrent: () => void): Promise<ExtensionLocalFile | null> {
    return this.#mutate(id, async () => {
      assertCurrent()
      const owned = await this.#owned(id)
      const source = owned.find(item => item.resource.id === resourceId)
      if (!source)
        return null
      if (source.generated)
        this.#assertCreationBudget(id, source.resource.size, owned)
      const resource = extensionLocalFileSchema.parse({ ...source.resource, id: randomUUID(), name: name ?? source.resource.name })
      await writeExtensionJson(this.#ownedPath(id), [...owned, { ...source, resource }], assertCurrent)
      return resource
    })
  }

  #assertCreationBudget(id: string, size: number, owned: Owned): void {
    const creating = this.#creating.get(id) ?? new Map<string, number>()
    const generated = owned.filter(item => item.generated)
    const reserved = [...creating.values()].reduce((sum, value) => sum + value, 0)
    if (creating.size >= 2 || generated.length + creating.size >= EXTENSION_CREATED_FILES_LIMIT || generated.reduce((sum, item) => sum + item.resource.size, reserved + size) > EXTENSION_CREATED_STORAGE_LIMIT)
      throw new Error('EXTENSION_RESOURCE_STORAGE_LIMIT')
  }

  async import(id: string, name: string, mimeType: string, response: Response, signal: AbortSignal, assertCurrent: () => void, generated = false): Promise<ExtensionLocalFile> {
    if (!response.ok || !response.body)
      throw new Error('EXTENSION_RESOURCE_DOWNLOAD_FAILED')
    const files = this.#files(id)
    const current = () => {
      signal.throwIfAborted()
      assertCurrent()
    }
    const draft = extensionLocalFileSchema.parse({ id: randomUUID(), name, mimeType, size: 0 })
    await this.#mutate(id, async () => {
      this.#imports.set(id, (this.#imports.get(id) ?? 0) + 1)
    })
    try {
      const asset = await files.put(response.body, signal, current)
      return await this.#mutate(id, async () => {
        const owned = await this.#owned(id)
        const resource = { ...draft, size: asset.size }
        await writeExtensionJson(this.#ownedPath(id), [...owned, { resource, key: asset.key, ...(generated ? { generated: true } : {}) }], current)
        return resource
      })
    }
    finally {
      await this.#mutate(id, async () => {
        const active = this.#imports.get(id)! - 1
        if (active)
          this.#imports.set(id, active)
        else
          this.#imports.delete(id)
        await this.#collectOwned(id)
      })
    }
  }

  async #collectOwned(id: string): Promise<void> {
    if (!this.#imports.has(id))
      await this.#files(id).collect(new Set((await this.#owned(id)).map(item => item.key)))
  }

  release(id: string, resourceId: string, assertCurrent: () => void): Promise<void> {
    return this.#mutate(id, async () => {
      const owned = await this.#owned(id)
      const retained = owned.filter(item => item.resource.id !== resourceId)
      await writeExtensionJson(this.#ownedPath(id), retained, assertCurrent)
      this.#abort(id, resourceId)
      await this.#collectOwned(id)
    })
  }

  async response(id: string, resourceId: string, request: Request, lifetime: AbortSignal, allowLocal = true): Promise<Response> {
    z.string().uuid().parse(resourceId)
    const controller = new AbortController()
    const key = `${id}:${resourceId}`
    const streams = this.#streams.get(key) ?? new Set<AbortController>()
    streams.add(controller)
    this.#streams.set(key, streams)
    const signal = AbortSignal.any([request.signal, lifetime, controller.signal])
    const close = () => {
      streams.delete(controller)
      if (!streams.size)
        this.#streams.delete(key)
    }
    try {
      signal.throwIfAborted()
      const owned = (await this.#owned(id)).find(item => item.resource.id === resourceId)
      if (owned)
        return await this.#files(id).response(owned.key, owned.resource.mimeType, request, signal, close, 'EXTENSION_RESOURCE_REVOKED')
      const grant = allowLocal ? (await this.#read(id)).find(grant => grant.resource.id === resourceId) : undefined
      if (!grant || await realpath(grant.path) !== grant.path)
        throw new Error('EXTENSION_RESOURCE_UNAVAILABLE')
      if (grant.directoryId) {
        const directory = (await this.#directories(id)).find(directory => directory.resource.id === grant.directoryId)
        await this.#assertDirectory(directory)
        if (!containsCanonicalPath(directory!.path, grant.path))
          throw new Error('EXTENSION_RESOURCE_DIRECTORY_CHANGED')
      }
      const handle = await open(grant.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const stat = await handle.stat({ bigint: true })
        if (!stat.isFile() || JSON.stringify(identity(stat)) !== JSON.stringify(grant.identity))
          throw new Error('EXTENSION_RESOURCE_CHANGED')
        return await fileResponse(handle, grant.resource.size, grant.resource.mimeType, request, signal, close, 'EXTENSION_RESOURCE_REVOKED')
      }
      catch (error) {
        await handle.close().catch(() => {})
        throw error
      }
    }
    catch (error) {
      close()
      throw error
    }
  }

  #files(id: string): FileAssetStore {
    return new FileAssetStore(join(this.#root, 'data', extensionIdSchema.parse(id), 'files'))
  }

  #ownedPath(id: string): string {
    return join(this.#root, 'data', extensionIdSchema.parse(id), 'owned-resources.json')
  }

  async #owned(id: string): Promise<Owned> {
    try {
      return ownedSchema.parse(await readExtensionJson(this.#ownedPath(id)))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return []
      throw new Error('EXTENSION_RESOURCE_REGISTRY_UNREADABLE')
    }
  }

  #path(id: string): string {
    return join(this.#root, 'data', extensionIdSchema.parse(id), 'local-resources.json')
  }

  #directoryPath(id: string): string {
    return join(this.#root, 'data', extensionIdSchema.parse(id), 'local-directories.json')
  }

  async #directories(id: string): Promise<DirectoryGrant[]> {
    try {
      return directoriesSchema.parse(await readExtensionJson(this.#directoryPath(id)))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return []
      throw new Error('EXTENSION_RESOURCE_REGISTRY_UNREADABLE')
    }
  }

  async #assertDirectory(directory: DirectoryGrant | undefined): Promise<void> {
    if (!directory || await realpath(directory.path) !== directory.path)
      throw new Error('EXTENSION_RESOURCE_DIRECTORY_UNAVAILABLE')
    const stat = await lstat(directory.path, { bigint: true })
    if (!stat.isDirectory() || directory.device !== String(stat.dev) || directory.inode !== String(stat.ino))
      throw new Error('EXTENSION_RESOURCE_DIRECTORY_CHANGED')
  }

  #abort(id: string, resourceId: string): void {
    for (const controller of this.#streams.get(`${id}:${resourceId}`) ?? []) controller.abort()
  }

  async #read(id: string): Promise<Grant[]> {
    try {
      return grantsSchema.parse(await readExtensionJson(this.#path(id), 4 * 1024 * 1024))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return []
      throw new Error('EXTENSION_RESOURCE_REGISTRY_UNREADABLE')
    }
  }

  async #mutate<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.#writes.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.#writes.set(id, task)
    try {
      return await task
    }
    finally {
      if (this.#writes.get(id) === task)
        this.#writes.delete(id)
    }
  }
}
