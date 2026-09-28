import type { ListenerErrorHandler } from '../../../shared/events/Emitter'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { BuddyCapabilityContext } from '../agent/extensions/BuddyCapability'
import { Buffer } from 'node:buffer'
import { open, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { zipSync } from 'fflate/browser'
import { readExtensionDirectory } from '../../../platform/extensions/extensionFiles'
import { containsCanonicalPath } from '../../../platform/filesystem/filePaths'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { EXTENSION_BUILD_RPC, EXTENSION_REVIEW_REQUEST, extensionBuildResultSchema } from '../../../shared/extensions/extensionAuthoring'
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
    try {
      const abort = AbortSignal.any([context.signal, this.#stop.signal, ...signal ? [signal] : []])
      abort.throwIfAborted()
      const grants = context.getExecutionGrants?.(toolCallId) ?? context.grants
      const source = await resolveGrantedPath(grants, resolve(context.cwd, input.source), 'existing')
      const output = await resolveGrantedPath(grants, resolve(context.cwd, input.output), 'create')
      if (!output.canonicalPath.endsWith('.lexora-extension') || containsCanonicalPath(source.canonicalPath, output.canonicalPath))
        throw new Error('EXTENSION_OUTPUT_INVALID')
      const files = await readExtensionDirectory(source.canonicalPath)
      const archive = Buffer.from(zipSync(Object.fromEntries(files), { level: 6 })).toString('base64')
      const result = extensionBuildResultSchema.parse(await this.#peer.request(EXTENSION_BUILD_RPC, { archive }, 45000, abort))
      diagnostics.push(...result.diagnostics)
      if (!result.ok)
        return { ok: false, code: result.code, diagnostics }
      abort.throwIfAborted()
      const currentOutput = await resolveGrantedPath(grants, resolve(context.cwd, input.output), 'create')
      if (currentOutput.canonicalPath !== output.canonicalPath)
        throw new Error('EXTENSION_OUTPUT_CHANGED')
      const bytes = Buffer.from(result.archive, 'base64')
      const handle = await open(output.canonicalPath, 'wx', 0o600)
      try {
        await handle.writeFile(bytes, { signal: abort })
        await handle.sync()
      }
      catch (error) {
        await handle.close()
        await rm(output.canonicalPath, { force: true })
        throw error
      }
      finally { await handle.close() }
      const identity = { operationId, extensionId: result.id, conversationId: context.conversationId, runId, bytes: bytes.length }
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
  }
}
