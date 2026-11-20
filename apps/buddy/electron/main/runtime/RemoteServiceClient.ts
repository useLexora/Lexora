import type { RuntimeLifecycleChange, RuntimeLifecycleSnapshot } from '../../../shared/lifecycle/runtimeLifecycle'
import type { DesktopClientRequestMethod, DesktopHostRequestMethod } from '../../../shared/runtime/desktopHostRequests'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ServiceHostBootstrap } from '../../../shared/service/localServiceProtocol'
import type { BuddyServiceNotification, BuddyServiceRequestOptions, BuddyServiceSupervisorState } from './BuddyServiceSupervisor'
import { randomUUID } from 'node:crypto'
import { connectLocalService } from '../../../platform/service/connectLocalService'
import { ServiceRpcChannel } from '../../../platform/service/ServiceRpcChannel'
import { Emitter } from '../../../shared/events/Emitter'
import { SERVICE_LIFECYCLE_METHOD, serviceLifecycleChangeSchema } from '../../../shared/lifecycle/serviceLifecycle'
import { serviceMaintenanceTicketSchema, serviceRuntimeStateSchema } from '../../../shared/service/localServiceProtocol'

function reconnecting(cause?: unknown) {
  return Object.assign(new Error('Desktop is reconnecting to the local service', { cause }), { code: 'RUNTIME_RECONNECTING' })
}

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
  #retry: NodeJS.Timeout | undefined
  #retryDelay = 250
  #daemonReady = true
  #closed = false
  #transitioning = false

  constructor(bootstrap: ServiceHostBootstrap, host: RuntimeRpcPeerContract) {
    this.#bootstrap = bootstrap
    this.#host = host
    this.#snapshot = { revision: 0, generation: bootstrap.identity.serviceInstanceId, status: 'stopped', maintenance: null, errorCode: null, connection: null, services: null }
    host.onNotification((method, params) => {
      if (method === 'service.runtimeState') {
        const state = serviceRuntimeStateSchema.parse(params)
        if (this.#closed)
          return
        const generationChanged = state.generation !== this.#snapshot.generation
        const changed = generationChanged || state.maintenance !== this.#snapshot.maintenance
        this.#daemonReady = state.status === 'ready'
        this.#snapshot = { ...this.#snapshot, generation: state.generation, maintenance: state.maintenance, services: generationChanged ? null : this.#snapshot.services }
        if (this.#daemonReady) {
          if (this.#peer)
            this.#setState('ready', changed)
          else
            this.start()
        }
        else {
          clearTimeout(this.#retry)
          this.#retry = undefined
          this.#setState(state.status, changed)
        }
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

  requestHost(method: DesktopHostRequestMethod, params: unknown, options: BuddyServiceRequestOptions = {}): Promise<unknown> {
    return this.#host.request(method, params, options.timeoutMs, options.signal, options.requestId)
  }

  async request<Method extends string>(method: Method & DesktopClientRequestMethod<Method>, params: unknown, options: BuddyServiceRequestOptions = {}): Promise<unknown> {
    const peer = await this.#connect()
    try {
      return await peer.request(method, params, options.timeoutMs, options.signal, options.requestId)
    }
    catch (error) {
      if (peer.closed && this.#daemonReady && !this.#closed && !this.#transitioning && !options.signal?.aborted)
        throw reconnecting(error)
      throw error
    }
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
      this.#scheduleReconnect()
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
    clearTimeout(this.#retry)
    this.#peer?.close(new Error('DESKTOP_CLIENT_CLOSED'))
    this.#setState('stopped')
  }

  #connect(): Promise<ServiceRpcChannel> {
    if (this.#closed)
      return Promise.reject(new Error('SERVICE_CLIENT_STOPPED'))
    if (this.#snapshot.maintenance || this.#state.status === 'stopping')
      return Promise.reject(new Error('SERVICE_MAINTENANCE'))
    if (!this.#daemonReady)
      return Promise.reject(new Error('SERVICE_NOT_READY'))
    if (this.#peer)
      return Promise.resolve(this.#peer)
    if (this.#retry)
      return Promise.reject(reconnecting())
    if (!this.#connecting) {
      this.#connecting = Promise.resolve().then(() => this.#attach()).catch((error) => {
        if (!this.#closed && this.#daemonReady && !this.#transitioning) {
          this.#setState('offline')
          throw reconnecting(error)
        }
        throw error
      }).finally(() => {
        this.#connecting = undefined
        this.#scheduleReconnect()
      })
    }
    return this.#connecting
  }

  async #attach(): Promise<ServiceRpcChannel> {
    if (this.#state.status !== 'offline')
      this.#setState('starting')
    const { frames } = await connectLocalService(this.#bootstrap.managementEndpoint, { ...this.#bootstrap.identity, type: 'hello', role: 'management', secret: this.#bootstrap.managementSecret })
    const peer = new ServiceRpcChannel(frames)
    try {
      if (this.#closed || !this.#daemonReady)
        throw new Error('SERVICE_CONNECTION_CLOSED')
      peer.onNotification((method, params) => this.#notifications.fire({ method, params }))
      const attached = await peer.request('service.attachDesktop', { expectedServiceInstanceId: this.#bootstrap.identity.serviceInstanceId }, 120000) as { pid: number, generation: string }
      if (peer.closed || this.#closed || !this.#daemonReady)
        throw new Error('SERVICE_CONNECTION_CLOSED')
      this.#peer = peer
      peer.onDidClose(() => {
        this.#peer = undefined
        if (!this.#closed && this.#daemonReady && !this.#transitioning)
          this.#setState('offline')
        this.#scheduleReconnect()
      })
      clearTimeout(this.#retry)
      this.#retry = undefined
      this.#retryDelay = 250
      this.#snapshot = { ...this.#snapshot, generation: attached.generation }
      this.#state.pid = attached.pid
      this.#setState('ready')
      return peer
    }
    catch (error) {
      peer.close(new Error('SERVICE_ATTACH_FAILED'))
      throw error
    }
  }

  #scheduleReconnect(): void {
    if (this.#peer || this.#connecting || this.#retry || this.#closed || this.#transitioning || !this.#daemonReady)
      return
    this.#retry = setTimeout(() => {
      this.#retry = undefined
      this.start()
    }, this.#retryDelay).unref()
    this.#retryDelay = Math.min(this.#retryDelay * 2, 5000)
  }

  #setState(status: BuddyServiceSupervisorState['status'], changed = false): void {
    if (!changed && status === this.#state.status && this.#snapshot.connection)
      return
    this.#state = { ...this.#state, status, lastError: status === 'offline' ? 'RUNTIME_STOPPED' : null }
    const connection = { component: 'runtime.connection', kind: 'service' as const, status: status === 'ready' ? 'ready' as const : status === 'starting' ? 'starting' as const : status === 'offline' ? 'start_failed' as const : 'stopped' as const, operationId: this.#bootstrap.identity.serviceInstanceId }
    this.#snapshot = { ...this.#snapshot, revision: this.#snapshot.revision + 1, status, errorCode: this.#state.lastError, connection }
    this.#changes.fire(this.state)
    this.#lifecycle.fire({ snapshot: this.lifecycleState, connection })
  }
}
