import type { ListenerErrorHandler } from '../../../shared/events/Emitter'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { BuddyCapabilityContext } from '../agent/extensions/BuddyCapability'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { link, mkdtemp, open, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { zipSync } from 'fflate/browser'
import { readExtensionDirectory, sha256 } from '../../../platform/extensions/extensionFiles'
import { containsCanonicalPath } from '../../../platform/filesystem/filePaths'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { EXTENSION_PACKAGE_TRANSFER_RPC, EXTENSION_REVIEW_REQUEST, extensionTransferChunkSchema, extensionTransferOffsetSchema, extensionTransferredBuildResultSchema, extensionTransferSessionSchema } from '../../../shared/extensions/extensionAuthoring'
import { EXTENSION_PACKAGE_CHUNK_BYTES, validateExtensionArchiveSize } from '../../../shared/extensions/extensionPackageBudget'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'

export interface PluginAuthoringChange {
  readonly kind: 'package-written' | 'review-requested' | 'review-failed'
  readonly operationId: string
  readonly extensionId: string
  readonly conversationId: string
  readonly runId?: string
  readonly bytes: number
  readonly errorCode?: string
}

export class PluginAuthoringService {
  readonly #peer: Pick<RuntimeRpcPeerContract, 'request' | 'notify'>
  readonly #changes: Emitter<PluginAuthoringChange>
  readonly onDidChange
  readonly #pending = new Set<Promise<Record<string, unknown> & { ok: boolean }>>()
  readonly #stop = new AbortController()
  #disposing: Promise<void> | undefined

  constructor(peer: Pick<RuntimeRpcPeerContract, 'request' | 'notify'>, onObserverError: ListenerErrorHandler = () => console.error('PLUGIN_AUTHORING_OBSERVER_FAILED')) {
    this.#peer = peer
    this.#changes = new Emitter(onObserverError)
    this.onDidChange = this.#changes.event
  }

  build(context: BuddyCapabilityContext, toolCallId: string, input: { source: string, output: string, review?: boolean }, signal?: AbortSignal): Promise<Record<string, unknown> & { ok: boolean }> {
    if (this.#stop.signal.aborted)
      return Promise.resolve({ ok: false, code: 'EXTENSION_HOST_STOPPED', diagnostics: [] })
    const pending = Promise.resolve().then(() => this.#build(context, toolCallId, input, signal)).finally(() => this.#pending.delete(pending))
    this.#pending.add(pending)
    return pending
  }

  dispose(): Promise<void> {
    if (this.#disposing)
      return this.#disposing
    this.#disposing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#pending])
      this.#changes.dispose()
    })
    this.#stop.abort()
    return this.#disposing
  }

  async #build(context: BuddyCapabilityContext, toolCallId: string, input: { source: string, output: string, review?: boolean }, signal?: AbortSignal): Promise<Record<string, unknown> & { ok: boolean }> {
    const diagnostics: string[] = []
    const operationId = crypto.randomUUID()
    const runId = context.getRunId()
    let transferId: string | undefined
    try {
      const abort = AbortSignal.any([context.signal, this.#stop.signal, ...signal ? [signal] : []])
      abort.throwIfAborted()
      const grants = context.getExecutionGrants?.(toolCallId) ?? context.grants
      const source = await resolveGrantedPath(grants, resolve(context.cwd, input.source), 'existing')
      const output = await resolveGrantedPath(grants, resolve(context.cwd, input.output), 'create')
      if (!output.canonicalPath.endsWith('.lexora-extension') || containsCanonicalPath(source.canonicalPath, output.canonicalPath))
        throw new Error('EXTENSION_OUTPUT_INVALID')
      const files = await readExtensionDirectory(source.canonicalPath)
      const archive = zipSync(Object.fromEntries(files), { level: 6 })
      files.clear()
      validateExtensionArchiveSize(archive.byteLength)
      transferId = extensionTransferSessionSchema.parse(await this.#peer.request(EXTENSION_PACKAGE_TRANSFER_RPC, { action: 'begin', size: archive.byteLength, sha256: sha256(archive) }, 10000, abort)).transferId
      for (let offset = 0; offset < archive.byteLength; offset += EXTENSION_PACKAGE_CHUNK_BYTES) {
        abort.throwIfAborted()
        const chunk = archive.subarray(offset, offset + EXTENSION_PACKAGE_CHUNK_BYTES)
        const uploaded = extensionTransferOffsetSchema.parse(await this.#peer.request(EXTENSION_PACKAGE_TRANSFER_RPC, { action: 'upload', transferId, offset, data: Buffer.from(chunk).toString('base64') }, 10000, abort))
        if (uploaded.offset !== offset + chunk.byteLength)
          throw new Error('EXTENSION_TRANSFER_ORDER')
      }
      const result = extensionTransferredBuildResultSchema.parse(await this.#peer.request(EXTENSION_PACKAGE_TRANSFER_RPC, { action: 'build', transferId }, 45000, abort))
      diagnostics.push(...result.diagnostics)
      if (!result.ok)
        return { ok: false, code: result.code, diagnostics }
      abort.throwIfAborted()
      const currentOutput = await resolveGrantedPath(grants, resolve(context.cwd, input.output), 'create')
      if (currentOutput.canonicalPath !== output.canonicalPath)
        throw new Error('EXTENSION_OUTPUT_CHANGED')
      const staging = await mkdtemp(join(dirname(output.canonicalPath), '.lexora-package-'))
      try {
        const candidate = join(staging, 'package')
        const handle = await open(candidate, 'wx', 0o600)
        try {
          const hash = createHash('sha256')
          let offset = 0
          while (offset < result.package.size) {
            abort.throwIfAborted()
            const chunk = extensionTransferChunkSchema.parse(await this.#peer.request(EXTENSION_PACKAGE_TRANSFER_RPC, { action: 'read', transferId, offset }, 10000, abort))
            const bytes = Buffer.from(chunk.data, 'base64')
            if (!bytes.length || bytes.length > EXTENSION_PACKAGE_CHUNK_BYTES || bytes.toString('base64') !== chunk.data || chunk.offset !== offset + bytes.length || chunk.offset > result.package.size)
              throw new Error('EXTENSION_TRANSFER_ORDER')
            await handle.writeFile(bytes, { signal: abort })
            hash.update(bytes)
            offset = chunk.offset
          }
          if (hash.digest('hex') !== result.package.sha256)
            throw new Error('EXTENSION_TRANSFER_CHECKSUM_FAILED')
          await handle.sync()
        }
        finally { await handle.close() }
        abort.throwIfAborted()
        const destination = await resolveGrantedPath(grants, resolve(context.cwd, input.output), 'create')
        if (destination.canonicalPath !== output.canonicalPath)
          throw new Error('EXTENSION_OUTPUT_CHANGED')
        await link(candidate, destination.canonicalPath)
      }
      finally { await rm(staging, { recursive: true, force: true }) }
      const identity = { operationId, extensionId: result.id, conversationId: context.conversationId, runId, bytes: result.package.size }
      this.#changes.fire(copyEventSnapshot({ kind: 'package-written', ...identity }))
      let reviewRequested = false
      let reviewError: string | undefined
      if (input.review) {
        try {
          abort.throwIfAborted()
          this.#peer.notify(EXTENSION_REVIEW_REQUEST, { path: output.canonicalPath })
          reviewRequested = true
          this.#changes.fire(copyEventSnapshot({ kind: 'review-requested', ...identity }))
        }
        catch {
          reviewError = abort.aborted ? 'EXTENSION_REVIEW_CANCELLED' : 'EXTENSION_REVIEW_REQUEST_FAILED'
          this.#changes.fire(copyEventSnapshot({ kind: 'review-failed', ...identity, errorCode: reviewError }))
        }
      }
      return { ok: true, id: result.id, name: result.name, author: result.author, version: result.version, packagePath: output.canonicalPath, diagnostics, reviewRequested, ...(reviewError ? { reviewError } : {}), installation: reviewRequested ? 'review_requested' : reviewError ? 'review_failed' : 'not_requested', runtimeTested: false }
    }
    catch (error) {
      const code = (error as { code?: string }).code ?? (error instanceof Error ? error.message : '')
      return { ok: false, code: /^[A-Z][A-Z_]+$/.test(code) ? code : 'EXTENSION_BUILD_FAILED', diagnostics }
    }
    finally {
      if (transferId)
        await this.#peer.request(EXTENSION_PACKAGE_TRANSFER_RPC, { action: 'dispose', transferId }, 10000).catch(() => {})
    }
  }
}
