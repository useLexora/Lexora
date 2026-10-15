import type { MutationClaim, MutationLifetime } from '../changes/MutationCoordinator'
import type { NativeFileClaim, NativeFileEngine } from './NativeFileEngine'
import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname, relative, sep } from 'node:path'
import { filePaths } from '../../../platform/filesystem/filePaths'
import { resolveFilePath } from '../../../platform/filesystem/resolveFilePath'

interface FileResource { canonicalPath: string, root: string, path: string }

export class FileResourceCoordinator {
  readonly #engine: NativeFileEngine
  readonly #resources = new Map<string, FileResource[]>()

  constructor(engine: NativeFileEngine) { this.#engine = engine }

  async reconcile(hazards: readonly { invocationId: string, claims: readonly MutationClaim[] }[], isReleased: (id: string) => boolean): Promise<void> {
    const existing = new Set(await this.#engine.leases())
    for (const id of existing) {
      if (!hazards.some(hazard => hazard.invocationId === id) && isReleased(id))
        await this.#engine.release(id)
    }
    for (const hazard of hazards) {
      if (!existing.has(hazard.invocationId))
        await this.acquire(hazard.invocationId, hazard.claims, 'external')
      await this.#engine.release(hazard.invocationId, true)
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

  async write(id: string, path: string, text: string, expected?: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const resource = await this.leased(id, path)
    const operationId = randomUUID()
    const cancel = () => {
      void this.#engine.cancel(operationId).catch(() => {})
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      signal?.throwIfAborted()
      const record = await this.#engine.mutate({ operationId, root: resource.root, path: resource.path, leaseId: id, action: { kind: 'write', text, expected } })
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
    let root = tree ? path : dirname(path)
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
    return { canonicalPath: path, root: key, path: relative(root, path).split(sep).join('/') }
  }
}
