import type { AuthenticationResponseDetails, AuthInfo, Event, ProxyConfig, Session, WebContents } from 'electron'
import type { NetworkStartupFailure } from '../../../shared/diagnostics/networkStartupFailure'
import type { ProxySettings } from '../../../shared/network/proxySettings'
import { randomUUID } from 'node:crypto'
import { app, session } from 'electron'
import { NetworkStartupError } from '../../../shared/diagnostics/networkStartupFailure'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { OutboundProxy, toElectronProxyConfig } from './OutboundProxy'
import { requestThroughHost } from './requestThroughHost'

const UNAVAILABLE_PROXY_URL = 'http://127.0.0.1:0'

export interface DesktopNetworkChange {
  readonly kind: 'lifecycle' | 'configuration' | 'session'
  readonly revision: number
  readonly operationId: string
  readonly status: 'starting' | 'ready' | 'degraded' | 'applied' | 'failed' | 'unavailable' | 'stopping' | 'stopped'
  readonly mode: ProxySettings['mode'] | null
  readonly failure?: NetworkStartupFailure
}

export class DesktopNetwork {
  readonly #changes = new Emitter<DesktopNetworkChange>(() => console.error('NETWORK_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #status: 'idle' | 'starting' | 'ready' | 'degraded' | 'stopping' | 'stopped' | 'stop-failed' = 'idle'
  #stopPromise: Promise<void> | undefined
  readonly #resolver = session.fromPartition(`lexora-proxy-resolver:${randomUUID()}`, { cache: false })
  readonly #proxy = new OutboundProxy(url => this.#resolve(url))
  #settings: ProxySettings | null = null
  #updating: Promise<void> = Promise.resolve()
  #sessionConfig: ProxyConfig | null = null
  readonly #sessionSetup = new Set<Promise<void>>()
  #sessionFailure: unknown
  readonly #failedSessions = new Map<Session, unknown>()
  #startupError: NetworkStartupError | null = null

  get startupError(): NetworkStartupError | null { return this.#startupError }
  get activity() { return this.#proxy.activity }
  get snapshot() { return copyEventSnapshot({ revision: this.#revision, status: this.#status, mode: this.#settings?.mode ?? null, pendingSessions: this.#sessionSetup.size, failedSessions: this.#failedSessions.size, failure: this.#startupError?.failure ?? null }) }
  get proxyUrl(): string { return this.#startupError ? UNAVAILABLE_PROXY_URL : this.#proxy.url }
  get sandboxProxyUrl(): string { return this.#startupError ? UNAVAILABLE_PROXY_URL : this.#proxy.sandboxUrl }

  readonly assertAvailable = (): void => {
    if (this.#startupError)
      throw this.#startupError
  }

  readonly get = async (url: string, init?: Pick<RequestInit, 'headers' | 'signal'>): Promise<Response> => {
    this.assertAvailable()
    return requestThroughHost(
      session.defaultSession,
      { url, method: 'GET', headers: Object.fromEntries(new Headers(init?.headers)) },
      init?.signal ?? AbortSignal.timeout(30_000),
      this.authenticateProxy,
    )
  }

  readonly authenticateProxy = (authInfo: AuthInfo, callback: (username?: string, password?: string) => void): boolean => {
    if (!authInfo.isProxy || authInfo.host !== '127.0.0.1' || authInfo.port !== this.#proxy.port)
      return false
    callback(this.#proxy.username, this.#proxy.password)
    return true
  }

  readonly #onSessionCreated = (created: Session) => {
    if (created === this.#resolver)
      return
    if (!this.#sessionConfig || this.#stopPromise)
      return
    this.#configureSession(created)
  }

  #configureSession(created: Session): Promise<void> {
    const operationId = randomUUID()
    const config = { ...this.#sessionConfig! }
    const setup = Promise.resolve().then(() => created.setProxy(config)).then(() => {
      this.#sessionSetup.delete(setup)
      this.#failedSessions.delete(created)
      this.#sessionFailure = [...this.#failedSessions.values()][0]
      if (!this.#startupError && !this.#failedSessions.size && this.#status === 'degraded')
        this.#status = 'ready'
      this.#publish('session', 'applied', operationId)
    }).catch((error: unknown) => {
      this.#sessionSetup.delete(setup)
      this.#failedSessions.set(created, error)
      this.#sessionFailure = error
      if (this.#status !== 'stopping')
        this.#status = 'degraded'
      this.#publish('session', 'failed', operationId, new NetworkStartupError('configure_sessions', error).failure)
    })
    this.#sessionSetup.add(setup)
    return setup
  }

  readonly #onLogin = (event: Event, _contents: WebContents | null, _details: AuthenticationResponseDetails, authInfo: AuthInfo, callback: (username?: string, password?: string) => void) => {
    if (authInfo.isProxy && authInfo.host === '127.0.0.1' && authInfo.port === this.#proxy.port) {
      event.preventDefault()
      this.authenticateProxy(authInfo, callback)
    }
  }

  async start(settings: ProxySettings): Promise<void> {
    if (this.#status !== 'idle' || this.#stopPromise)
      throw new Error('NETWORK_ALREADY_STARTED')
    this.#status = 'starting'
    const operationId = randomUUID()
    this.#publish('lifecycle', 'starting', operationId)
    let operation: NetworkStartupFailure['operation'] = 'configure_upstream'
    try {
      await this.apply(settings)
      operation = 'listen'
      await this.#proxy.start()
    }
    catch (cause) {
      this.#startupError = new NetworkStartupError(operation, cause)
      this.#proxy.disconnect()
      this.#status = 'degraded'
      this.#publish('lifecycle', 'degraded', operationId, this.#startupError.failure)
    }
    this.#sessionConfig = { mode: 'fixed_servers', proxyRules: this.#startupError ? this.proxyUrl : this.#proxy.address, proxyBypassRules: '<-loopback>' }
    app.on('login', this.#onLogin)
    app.on('session-created', this.#onSessionCreated)
    try {
      await Promise.all([app.setProxy(this.#sessionConfig), session.defaultSession.setProxy(this.#sessionConfig)])
    }
    catch (cause) {
      this.#startupError = new NetworkStartupError('configure_sessions', cause)
      this.#status = 'degraded'
      this.#publish('lifecycle', 'failed', operationId, this.#startupError.failure)
      throw this.#startupError
    }
    this.#status = this.#startupError || this.#sessionFailure ? 'degraded' : 'ready'
    if (!this.#startupError)
      this.#publish('lifecycle', this.#status, operationId)
  }

  async apply(settings: ProxySettings): Promise<void> {
    if (this.#stopPromise || this.#status === 'stopped')
      throw new Error('NETWORK_STOPPED')
    const input = { ...settings }
    const operation = this.#updating.then(async () => {
      const operationId = randomUUID()
      if (this.#startupError) {
        this.#publish('configuration', 'unavailable', operationId, this.#startupError.failure)
        return
      }
      if (input.mode !== this.#settings?.mode || input.server !== this.#settings.server) {
        try {
          await this.#resolver.setProxy(toElectronProxyConfig(input))
          this.#settings = input
          this.#proxy.disconnect()
          this.#publish('configuration', 'applied', operationId)
        }
        catch (cause) {
          this.#publish('configuration', 'failed', operationId, new NetworkStartupError('configure_upstream', cause).failure)
          throw cause
        }
      }
      await this.reconcileSessions()
    })
    this.#updating = operation.catch(() => {})
    await operation
  }

  async reconcileSessions(): Promise<void> {
    if (this.#sessionConfig && !this.#stopPromise)
      await Promise.all([...this.#failedSessions.keys()].map(current => this.#configureSession(current)))
  }

  async #resolve(url: string): Promise<string> {
    await this.#updating
    if (this.#startupError)
      throw this.#startupError
    if (this.#sessionFailure)
      throw this.#sessionFailure
    return this.#resolver.resolveProxy(url)
  }

  stop(): Promise<void> {
    this.#stopPromise ??= Promise.resolve().then(() => this.#stop())
    return this.#stopPromise
  }

  async #stop(): Promise<void> {
    const operationId = randomUUID()
    this.#status = 'stopping'
    this.#publish('lifecycle', 'stopping', operationId)
    app.off('session-created', this.#onSessionCreated)
    app.off('login', this.#onLogin)
    try {
      await this.#updating
      await Promise.allSettled(this.#sessionSetup)
      const resources = await Promise.allSettled([this.#proxy.stop(), this.#resolver.closeAllConnections()])
      const failures = resources.filter(result => result.status === 'rejected')
      if (failures.length)
        throw new AggregateError(failures.map(result => result.reason), 'NETWORK_STOP_FAILED')
      this.#status = 'stopped'
      this.#publish('lifecycle', 'stopped', operationId)
    }
    catch (error) {
      this.#status = 'stop-failed'
      this.#publish('lifecycle', 'failed', operationId)
      throw error
    }
    finally {
      this.#changes.dispose()
    }
  }

  #publish(kind: DesktopNetworkChange['kind'], status: DesktopNetworkChange['status'], operationId: string, failure?: NetworkStartupFailure): void {
    this.#changes.fire(copyEventSnapshot({ kind, status, operationId, revision: ++this.#revision, mode: this.#settings?.mode ?? null, ...(failure ? { failure } : {}) }))
  }
}
