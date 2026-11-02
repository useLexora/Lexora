import type { MutationClaim, MutationLifetime } from '../changes/MutationCoordinator'
import type { FileAction, NativeFileClaim, NativeFileEngine } from './NativeFileEngine'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { filePaths } from '../../../platform/filesystem/filePaths'
import { resolveFilePath } from '../../../platform/filesystem/resolveFilePath'

interface FileResource { canonicalPath: string, directory: string, root: string, path: string }

export interface FilePublication {
  path: string
  bytes: Uint8Array | AsyncIterable<Uint8Array>
  size: number
  overwrite?: boolean
  assertCurrent?: () => void | Promise<void>
}

const maxFileBytes = 64 * 1024 * 1024

export class FileResourceCoordinator {
  readonly #engine: NativeFileEngine
  readonly #resources = new Map<string, FileResource[]>()
  readonly #stagingRoots = new Map<string, string>()

  constructor(engine: NativeFileEngine) { this.#engine = engine }

  async reconcile(hazards: readonly { invocationId: string, claims: readonly MutationClaim[] }[], isReleased: (id: string) => boolean): Promise<void> {
    const existing = new Set(await this.#engine.leases())
    for (const id of existing) {
      if (!hazards.some(hazard => hazard.invocationId === id) && isReleased(id))
        await this.#engine.release(id)
    }
    for (const hazard of hazards) {
      await this.#engine.protect(hazard.invocationId, hazard.claims.map(claim => ({
        path: claim.kind === 'host' ? '*' : claim.canonicalPath,
        subtree: claim.kind !== 'file',
      })))
      this.#resources.delete(hazard.invocationId)
    }
  }

  async acquire(id: string, claims: readonly MutationClaim[], lifetime: MutationLifetime, signal?: AbortSignal): Promise<void> {
    const resources: FileResource[] = []
    const native: NativeFileClaim[] = []
    for (const claim of claims) {
      if (claim.kind === 'host') {
        native.push({ root: '*', path: '', subtree: true })
        continue
      }
      const resource = await this.resource(claim.canonicalPath, claim.kind === 'tree')
      resources.push(resource)
      native.push({ root: resource.root, path: resource.path, subtree: claim.kind === 'tree' })
    }
    await this.#engine.acquire(id, native, lifetime === 'external', signal)
    this.#resources.set(id, resources)
  }

  async release(id: string, hazard = false): Promise<void> {
    await this.#engine.release(id, hazard)
    this.#resources.delete(id)
  }

  async read(id: string, path: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const resource = await this.leased(id, path)
    const result = await this.#engine.read(resource.root, resource.path)
    signal?.throwIfAborted()
    return result
  }

  withStagingDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    return this.#engine.withStagingDirectory(async (directory, root) => {
      this.#stagingRoots.set(directory, root)
      try {
        return await operation(directory)
      }
      finally { this.#stagingRoots.delete(directory) }
    })
  }

  async fileWriteClaims(paths: readonly string[]): Promise<MutationClaim[]> {
    const claims: MutationClaim[] = []
    for (const path of paths) {
      const resource = await this.resource(path, false)
      claims.push({ kind: 'file', canonicalPath: path })
      if (resource.path.includes('/'))
        claims.push({ kind: 'tree', canonicalPath: join(resource.directory, resource.path.split('/')[0]!) })
    }
    return claims
  }

  async writeFile(id: string, stagingDirectory: string, input: FilePublication, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxFileBytes)
      throw new Error('FILE_INVALID_REQUEST')
    signal?.throwIfAborted()
    const resource = await this.leased(id, input.path)
    const staging = await this.leased(id, stagingDirectory)
    let expected: string | undefined
    if (input.overwrite) {
      const target = await resolveFilePath(input.path, 'create')
      if (target.isFile)
        expected = createHash('sha256').update(await this.#engine.readBytes(resource.directory, resource.canonicalPath, maxFileBytes, signal)).digest('hex')
    }
    const name = randomUUID()
    const handle = await open(join(stagingDirectory, name), 'wx', 0o600)
    let size = 0
    const hash = createHash('sha256')
    try {
      for await (const chunk of input.bytes instanceof Uint8Array ? [input.bytes] : input.bytes) {
        signal?.throwIfAborted()
        size += chunk.byteLength
        if (size > input.size)
          throw new Error('ARTIFACT_SIZE_LIMIT')
        hash.update(chunk)
        await handle.writeFile(chunk)
      }
      if (size !== input.size)
        throw new Error('ARTIFACT_SIZE_LIMIT')
      await handle.sync()
    }
    finally { await handle.close() }
    await input.assertCurrent?.()
    signal?.throwIfAborted()
    const parents = resource.path.split('/').slice(0, -1)
    for (let index = 0; index < parents.length; index++) {
      const path = parents.slice(0, index + 1).join('/')
      try {
        if (!(await lstat(join(resource.directory, path))).isDirectory())
          throw new Error('FILE_PERMISSION_REVOKED')
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error
        await this.mutate(id, resource, path, { kind: 'createDirectory' }, signal)
      }
    }
    await input.assertCurrent?.()
    await this.mutate(id, resource, resource.path, { kind: 'writeFile', stagingRoot: staging.root, stagingPath: `${staging.path}/${name}`, size, sha256: hash.digest('hex'), expected }, signal)
  }

  async write(id: string, path: string, text: string, expected?: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const resource = await this.leased(id, path)
    await this.mutate(id, resource, resource.path, { kind: 'write', text, expected }, signal)
  }

  private async mutate(id: string, resource: FileResource, path: string, action: FileAction, signal?: AbortSignal): Promise<void> {
    const operationId = randomUUID()
    const cancel = () => {
      void this.#engine.cancel(operationId).catch(() => {})
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      signal?.throwIfAborted()
      const record = await this.#engine.mutate({ operationId, root: resource.root, path, leaseId: id, action })
      if (record.status !== 'applied')
        throw new Error(record.error ?? 'FILE_RECOVERY_REQUIRED')
    }
    finally { signal?.removeEventListener('abort', cancel) }
  }

  private async leased(id: string, path: string): Promise<FileResource> {
    const resolved = await resolveFilePath(path, 'create')
    const resource = this.#resources.get(id)?.find(resource => filePaths.sensitiveKey(resource.canonicalPath) === filePaths.sensitiveKey(resolved.canonicalPath))
    if (!resource)
      throw new Error('FILE_LEASE_INVALID')
    return resource
  }

  private async resource(path: string, tree: boolean): Promise<FileResource> {
    let root = tree ? this.#stagingRoots.get(path) ?? path : dirname(path)
    let identity = ''
    while (true) {
      try {
        const metadata = await stat(root, { bigint: true })
        if (!metadata.isDirectory())
          throw new Error('FILE_INVALID_REQUEST')
        identity = `${metadata.dev}:${metadata.ino}`
        break
      }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT' || dirname(root) === root)
          throw error
        root = dirname(root)
      }
    }
    const key = `resource:${createHash('sha256').update(JSON.stringify([root, identity])).digest('hex')}`
    await this.#engine.register(key, root)
    return { canonicalPath: path, directory: root, root: key, path: relative(root, path).split(sep).join('/') }
  }
}
