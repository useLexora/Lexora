import type { ExtensionFileOpeningSource } from '../../../shared/extensions/extensionFileOpening'
import type { LocalDocumentCommit, LocalDocumentReceipt } from '../../../shared/files/localDocumentApi'
import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { NativeFileEngine, NativeFileMutation, NativeFileOperation } from './NativeFileEngine'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { localDocumentRpc } from '../../../shared/files/localDocumentApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export class LocalDocumentFileService {
  readonly #commits = new Map<string, { fingerprint: string, result: Promise<LocalDocumentReceipt> }>()
  private readonly home: string
  private readonly engine: NativeFileEngine
  private readonly resolve: (source: ExtensionFileOpeningSource) => Promise<string>
  constructor(home: string, engine: NativeFileEngine, resolve: (source: ExtensionFileOpeningSource) => Promise<string>) {
    this.home = home
    this.engine = engine
    this.resolve = resolve
  }

  commit(input: LocalDocumentCommit, signal?: AbortSignal): Promise<LocalDocumentReceipt> {
    const request = mutation(input)
    const fingerprint = JSON.stringify(request)
    const active = this.#commits.get(input.operationId)
    if (active)
      return active.fingerprint === fingerprint ? active.result : Promise.resolve(identityConflict(input))
    const result = this.apply(input, request, signal).finally(() => this.#commits.delete(input.operationId))
    this.#commits.set(input.operationId, { fingerprint, result })
    return result
  }

  private async apply(input: LocalDocumentCommit, request: NativeFileMutation, signal?: AbortSignal): Promise<LocalDocumentReceipt> {
    let leaseId: string | undefined
    let submitted = false
    const cancel = () => {
      void this.engine.cancel(input.operationId).catch(() => {})
    }
    try {
      signal?.throwIfAborted()
      const parent = await realpath(dirname(input.path))
      const stat = await lstat(parent, { bigint: true })
      if (parent !== dirname(input.path) || `${stat.dev}:${stat.ino}` !== input.parentIdentity)
        throw new Error('FILE_CONFLICT')
      await this.engine.register(request.root, parent)
      const stagingRoot = `document-upload:${input.extensionId}`
      await this.engine.register(stagingRoot, join(this.home, 'extensions', 'data', input.extensionId, 'documents', 'files'))
      const lease = randomUUID()
      await this.engine.acquire(lease, [{ root: request.root, path: request.path, subtree: true }, { root: stagingRoot, path: input.sha256, subtree: false }], false, signal)
      leaseId = lease
      signal?.addEventListener('abort', cancel, { once: true })
      signal?.throwIfAborted()
      if (input.source && await this.resolve(input.source) !== input.path)
        throw new Error('FILE_PERMISSION_REVOKED')
      signal?.throwIfAborted()
      submitted = true
      return receipt(await this.engine.mutate({ ...request, leaseId }), input)
    }
    catch (error) {
      if (error instanceof Error && error.message === 'FILE_OPERATION_ID_CONFLICT')
        return { operationId: input.operationId, status: 'not-applied', error: error.message }
      if (submitted) {
        const known = await this.engine.query(input.operationId, request)
        if (known)
          return receipt(known, input)
      }
      return { operationId: input.operationId, status: 'not-applied', error: signal?.aborted ? 'FILE_OPERATION_CANCELLED' : error instanceof Error ? error.message : 'FILE_IO_FAILED' }
    }
    finally {
      signal?.removeEventListener('abort', cancel)
      if (leaseId)
        await this.engine.release(leaseId)
    }
  }

  async query(input: LocalDocumentCommit): Promise<LocalDocumentReceipt> {
    const request = mutation(input)
    const active = this.#commits.get(input.operationId)
    if (active) {
      if (active.fingerprint !== JSON.stringify(request))
        return identityConflict(input)
      await active.result.catch(() => {})
    }
    try {
      const result = await this.engine.query(input.operationId, request)
      return result ? receipt(result, input) : { operationId: input.operationId, status: 'not-applied' }
    }
    catch (error) {
      if (error instanceof Error && error.message === 'FILE_OPERATION_ID_CONFLICT')
        return identityConflict(input)
      throw error
    }
  }
}

function identityConflict(input: LocalDocumentCommit): LocalDocumentReceipt {
  return { operationId: input.operationId, status: 'not-applied', error: 'FILE_OPERATION_ID_CONFLICT' }
}

function mutation(input: LocalDocumentCommit): NativeFileMutation {
  return {
    operationId: input.operationId,
    root: `document:${createHash('sha256').update(dirname(input.path)).digest('hex')}`,
    path: basename(input.path),
    action: {
      kind: 'writeFile',
      stagingRoot: `document-upload:${input.extensionId}`,
      stagingPath: input.sha256,
      sha256: input.sha256,
      size: input.size,
      ...(input.expected === null ? {} : { expected: input.expected }),
    },
  }
}

function receipt(record: NativeFileOperation, input: LocalDocumentCommit): LocalDocumentReceipt {
  if (record.operationId !== input.operationId || record.kind !== 'writeFile')
    throw new Error('FILE_OPERATION_ID_CONFLICT')
  if (record.status === 'applied') {
    if (record.receipt?.etag !== input.sha256)
      throw new Error('FILE_OPERATION_ID_CONFLICT')
    return { operationId: record.operationId, status: 'applied', version: input.sha256 }
  }
  return {
    operationId: record.operationId,
    status: record.status === 'not-applied' ? 'not-applied' : record.status === 'needs-recovery' || record.status === 'acknowledged' ? 'needs-recovery' : 'pending',
    ...(record.error ? { error: record.error } : {}),
  }
}

export function registerLocalDocumentRpc(rpc: RuntimeRequestRegistrar, service: LocalDocumentFileService) {
  const disposers = [
    registerRuntimeRequest(rpc, localDocumentRpc.commit, (input, signal) => service.commit(input, signal)),
    registerRuntimeRequest(rpc, localDocumentRpc.query, input => service.query(input)),
  ]
  return () => disposers.forEach(dispose => dispose())
}
