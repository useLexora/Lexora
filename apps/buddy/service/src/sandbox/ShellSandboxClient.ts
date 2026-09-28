import type { BashOperations } from '@earendil-works/pi-coding-agent'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { SandboxLifecycleEvent } from '../../../shared/permissions/sandboxLifecycle'
import type { SandboxCommand, SandboxNetworkTarget, SandboxResult } from '../../../shared/permissions/shellSandbox'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { sandboxLifecycleNotificationSchema } from '../../../shared/permissions/sandboxLifecycle'
import { SANDBOX_RPC_TIMEOUT_MS, sandboxNetworkRequestSchema, sandboxOutputSchema, sandboxResultSchema, ShellSandboxError } from '../../../shared/permissions/shellSandbox'

type ExecOptions = Parameters<BashOperations['exec']>[2]

type SandboxClientDetails
  = | { readonly kind: 'requested' }
    | { readonly kind: 'cancel-requested', readonly delivery: 'sent' | 'unavailable' }
    | { readonly kind: 'returned', readonly result: Readonly<SandboxResult> }
    | { readonly kind: 'transport-failed' }
    | { readonly kind: 'backend', readonly event: Readonly<SandboxLifecycleEvent> }

export type SandboxClientEvent = EventSnapshot<SandboxClientDetails & { readonly requestId: string, readonly revision: number }>

interface PendingCommand {
  approve: (target: SandboxNetworkTarget) => Promise<boolean>
  cancel: () => void
  settled: Promise<void>
}

export class ShellSandboxClient {
  readonly #peer: RuntimeRpcPeerContract
  readonly #pending = new Map<string, PendingCommand>()
  readonly #dispose: () => void
  readonly #changes = new Emitter<SandboxClientEvent>(() => console.error('SANDBOX_CLIENT_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #disposed = false

  constructor(peer: RuntimeRpcPeerContract) {
    this.#peer = peer
    this.#dispose = peer.onRequest('sandbox.network', async (params) => {
      const { requestId, ...target } = sandboxNetworkRequestSchema.parse(params)
      return { allowed: await this.#pending.get(requestId)?.approve(target) ?? false }
    })
  }

  async exec(
    input: Omit<SandboxCommand, 'requestId'>,
    options: ExecOptions,
    approveNetwork: (target: SandboxNetworkTarget) => Promise<boolean>,
  ): Promise<{ exitCode: number | null }> {
    if (this.#disposed)
      throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
    options.signal?.throwIfAborted()
    const requestId = randomUUID()
    let dispatched = false
    let returned = false
    let cancelled = false
    let backendRevision = 0
    const publish = (details: SandboxClientDetails) => this.#changes.fire(copyEventSnapshot({ ...details, requestId, revision: ++this.#revision }))
    const cancel = () => {
      if (cancelled || returned)
        return
      cancelled = true
      let delivery: 'sent' | 'unavailable' = 'sent'
      try {
        this.#peer.notify('host.sandbox.cancel', { requestId })
      }
      catch { delivery = 'unavailable' }
      publish({ kind: 'cancel-requested', delivery })
    }
    const unsubscribe = this.#peer.onNotification((method, params) => {
      if (method === 'host.sandbox.lifecycle') {
        const parsed = sandboxLifecycleNotificationSchema.safeParse(params)
        if (parsed.success && parsed.data.requestId === requestId && parsed.data.revision > backendRevision) {
          backendRevision = parsed.data.revision
          const { requestId: _, ...event } = parsed.data
          publish({ kind: 'backend', event })
        }
        return
      }
      if (method !== 'host.sandbox.output')
        return
      const parsed = sandboxOutputSchema.safeParse(params)
      if (parsed.success && parsed.data.requestId === requestId && !this.#disposed && !options.signal?.aborted)
        options.onData(Buffer.from(parsed.data.data, 'base64'))
    })
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.#pending.set(requestId, { approve: approveNetwork, cancel, settled })
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      publish({ kind: 'requested' })
      options.signal?.throwIfAborted()
      if (this.#disposed || cancelled)
        throw new ShellSandboxError('SANDBOX_CANCELLED')
      dispatched = true
      const result = sandboxResultSchema.parse(await this.#peer.request('host.sandbox.exec', { ...input, requestId }, SANDBOX_RPC_TIMEOUT_MS))
      returned = true
      publish({ kind: 'returned', result })
      options.signal?.throwIfAborted()
      if (!result.ok)
        throw new ShellSandboxError(result.code)
      return { exitCode: result.exitCode }
    }
    catch (error) {
      if (dispatched && !returned)
        publish({ kind: 'transport-failed' })
      throw error
    }
    finally {
      if (!returned)
        cancel()
      unsubscribe()
      this.#pending.delete(requestId)
      options.signal?.removeEventListener('abort', cancel)
      settle()
    }
  }

  async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true
      this.#dispose()
      for (const pending of this.#pending.values()) pending.cancel()
    }
    await Promise.all([...this.#pending.values()].map(pending => pending.settled))
    this.#changes.dispose()
  }
}
