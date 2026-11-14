import type { RuntimeLifecycleChange, RuntimeLifecycleSnapshot } from '../../../shared/lifecycle/runtimeLifecycle'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ServiceHostBootstrap } from '../../../shared/service/localServiceProtocol'
import type { BuddyServiceNotification, BuddyServiceRequestOptions, BuddyServiceSupervisorState } from './BuddyServiceSupervisor'
import { randomUUID } from 'node:crypto'
import { connectLocalService } from '../../../platform/service/connectLocalService'
import { ServiceRpcChannel } from '../../../platform/service/ServiceRpcChannel'
import { Emitter } from '../../../shared/events/Emitter'
import { SERVICE_LIFECYCLE_METHOD, serviceLifecycleChangeSchema } from '../../../shared/lifecycle/serviceLifecycle'
import { serviceMaintenanceTicketSchema, serviceRuntimeStateSchema } from '../../../shared/service/localServiceProtocol'

export class RemoteServiceClient {
  readonly #bootstrap: ServiceHostBootstrap
  readonly #host: RuntimeRpcPeerContract
  readonly #changes = new Emitter<BuddyServiceSupervisorState>(() => {})
  readonly #lifecycle = new Emitter<RuntimeLifecycleChange>(() => {})
  readonly #notifications = new Emitter<BuddyServiceNotification>(() => {})
  readonly onDidChangeLifecycle = this.#lifecycle.event
  #peer: ServiceRpcChannel | undefined
  #connecting: Promise<ServiceRpcChannel> | undefined
  #state: BuddyServiceSupervisorState = { status: 'stopped', pid: null, restartAttempt: 0, lastError: null }
  #snapshot: RuntimeLifecycleSnapshot
  #closed = false
  #transitioning = false

  constructor(bootstrap: ServiceHostBootstrap, host: RuntimeRpcPeerContract) {
    this.#bootstrap = bootstrap
    this.#host = host
    this.#snapshot = { revision: 0, generation: bootstrap.identity.serviceInstanceId, status: 'stopped', maintenance: null, errorCode: null, connection: null, services: null }
    host.onNotification((method, params) => {
      if (method === 'service.runtimeState') {
        const state = serviceRuntimeStateSchema.parse(params)
        this.#snapshot = { ...this.#snapshot, ...state, services: state.generation === this.#snapshot.generation ? this.#snapshot.services : null }
        this.#setState(state.status)
        if (state.status === 'ready' && !this.#closed)
          void this.#connect().catch(() => {})
      }
      if (method === SERVICE_LIFECYCLE_METHOD) {
        const change = serviceLifecycleChangeSchema.safeParse(params)
        if (change.success) {
          this.#snapshot = { ...this.#snapshot, revision: this.#snapshot.revision + 1, services: change.data.snapshot }
          this.#lifecycle.fire({ snapshot: this.lifecycleState })
        }
      }
      this.#notifications.fire({ method, params })
    })
  }

  get state() {
    return { ...this.#state }
  }

  get lifecycleState(): RuntimeLifecycleSnapshot {
    return structuredClone(this.#snapshot)
  }

  onStateChange(listener: (state: BuddyServiceSupervisorState) => void) {
    return this.#changes.event(listener).dispose
  }

  onNotification(listener: (notification: BuddyServiceNotification) => void) {
    return this.#notifications.event(listener).dispose
  }

  start(): void {
    void this.#connect().catch(() => {})
  }

  async request(method: string, params: unknown, options: BuddyServiceRequestOptions = {}): Promise<unknown> {
    const peer = method === 'extensions.inference.acquire' || method === 'extensions.inference.release' ? this.#host : await this.#connect()
    return peer.request(method, params, options.timeoutMs, options.signal, options.requestId)
  }

  notify(method: string, params: unknown): boolean {
    if (this.#closed)
      return false
    try {
      this.#host.notify(method, params)

      return true
    }
    catch {
      return false
    }
  }

  async restartDesktop(): Promise<void> {
    if (this.#closed || this.#transitioning)
      throw new Error('SERVICE_NOT_READY')
    await this.#host.request('service.restartDesktop', { expectedServiceInstanceId: this.#bootstrap.identity.serviceInstanceId }, 30000)
  }

  restart(): Promise<void> {
    return this.#withMaintenance('restart', async () => {})
  }

  withStoppedStorage<T>(operation: () => Promise<T>): Promise<T> {
    return this.#withMaintenance('backup', operation)
  }

  async #withMaintenance<T>(kind: 'backup' | 'restart', operation: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#transitioning || this.#state.status !== 'ready')
      throw new Error('SERVICE_NOT_READY')
    this.#transitioning = true
    try {
      const ticket = serviceMaintenanceTicketSchema.parse(await this.#host.request('service.beginMaintenance', { expectedServiceInstanceId: this.#bootstrap.identity.serviceInstanceId, kind }, 30000))
      try {
        return await operation()
      }
      finally {
        await this.#host.request('service.endMaintenance', ticket, 120000)
        await this.#connect()
      }
    }
    finally {
      this.#transitioning = false
    }
  }

  async stop(): Promise<void> {
    if (this.#closed)
      return
    let stop = () => {}
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finished = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('SERVICE_STOP_UNCONFIRMED')), 45000)
      stop = this.#host.onNotification((method) => {
        if (method === 'service.executionStopped')
          resolve()
      })
    })
    void finished.catch(() => {})
    try {
      await this.#host.request('service.exitDesktop', { expectedServiceInstanceId: this.#bootstrap.identity.serviceInstanceId, commandId: randomUUID(), reason: 'explicit' }, 30000)
      await finished
    }
    finally {
      clearTimeout(timeout)
      stop()
    }
    this.disconnect()
  }

  disconnect(): void {
    if (this.#closed)
      return
    this.#closed = true
    this.#peer?.close(new Error('DESKTOP_CLIENT_CLOSED'))
    this.#setState('stopped')
  }

  #connect(): Promise<ServiceRpcChannel> {
    if (this.#closed)
      return Promise.reject(new Error('SERVICE_CLIENT_STOPPED'))
    if (this.#snapshot.maintenance || this.#state.status === 'stopping')
      return Promise.reject(new Error('SERVICE_MAINTENANCE'))
    return this.#connecting ??= (async () => {
      this.#setState('starting')
      const { frames } = await connectLocalService(this.#bootstrap.managementEndpoint, { ...this.#bootstrap.identity, type: 'hello', role: 'management', secret: this.#bootstrap.managementSecret })
      const peer = new ServiceRpcChannel(frames)
      this.#peer = peer
      peer.onDidClose(() => {
        if (this.#peer !== peer)
          return
        this.#peer = undefined
        this.#connecting = undefined
        if (!this.#transitioning && !this.#snapshot.maintenance)
          this.#setState(this.#closed ? 'stopped' : 'offline')
      })
      peer.onNotification((method, params) => this.#notifications.fire({ method, params }))
      const attached = await peer.request('service.attachDesktop', { expectedServiceInstanceId: this.#bootstrap.identity.serviceInstanceId }, 120000) as { pid: number, generation: string }
      if (peer.closed || this.#closed)
        throw new Error('SERVICE_CONNECTION_CLOSED')
      this.#snapshot = { ...this.#snapshot, generation: attached.generation }
      this.#state.pid = attached.pid
      this.#setState('ready')
      return peer
    })().catch((error) => {
      this.#connecting = undefined
      if (!this.#transitioning && !this.#snapshot.maintenance)
        this.#setState('offline')
      throw error
    })
  }

  #setState(status: BuddyServiceSupervisorState['status']): void {
    this.#state = { ...this.#state, status, lastError: status === 'offline' ? 'RUNTIME_STOPPED' : null }
    const connection = { component: 'runtime.connection', kind: 'service' as const, status: status === 'ready' ? 'ready' as const : status === 'starting' ? 'starting' as const : status === 'offline' ? 'start_failed' as const : 'stopped' as const, operationId: this.#bootstrap.identity.serviceInstanceId }
    this.#snapshot = { ...this.#snapshot, revision: this.#snapshot.revision + 1, status, errorCode: this.#state.lastError, connection }
    this.#changes.fire(this.state)
    this.#lifecycle.fire({ snapshot: this.lifecycleState, connection })
  }
}
