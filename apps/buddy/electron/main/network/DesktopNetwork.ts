import type { AuthenticationResponseDetails, AuthInfo, Event, ProxyConfig, Session, WebContents } from 'electron'
import type { NetworkStartupFailure } from '../../../shared/diagnostics/networkStartupFailure'
import type { ProxySettings } from '../../../shared/network/proxySettings'
import { randomUUID } from 'node:crypto'
import { app, session } from 'electron'
import { NetworkStartupError } from '../../../shared/diagnostics/networkStartupFailure'
import { OutboundProxy, toElectronProxyConfig } from './OutboundProxy'
import { requestThroughHost } from './requestThroughHost'

const UNAVAILABLE_PROXY_URL = 'http://127.0.0.1:0'

export class DesktopNetwork {
  readonly #resolver = session.fromPartition(`lexora-proxy-resolver:${randomUUID()}`, { cache: false })
  readonly #proxy = new OutboundProxy(url => this.#resolve(url))
  #settings: ProxySettings | null = null
  #updating: Promise<void> = Promise.resolve()
  #sessionConfig: ProxyConfig | null = null
  readonly #sessionSetup = new Set<Promise<void>>()
  #sessionFailure: unknown
  #startupError: NetworkStartupError | null = null

  get startupError(): NetworkStartupError | null { return this.#startupError }
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
    if (!this.#sessionConfig)
      return
    const setup = created.setProxy(this.#sessionConfig)
    this.#sessionSetup.add(setup)
    void setup.catch((error: unknown) => {
      this.#sessionFailure = error
    }).finally(() => this.#sessionSetup.delete(setup))
  }

  readonly #onLogin = (event: Event, _contents: WebContents | null, _details: AuthenticationResponseDetails, authInfo: AuthInfo, callback: (username?: string, password?: string) => void) => {
    if (authInfo.isProxy && authInfo.host === '127.0.0.1' && authInfo.port === this.#proxy.port) {
      event.preventDefault()
      this.authenticateProxy(authInfo, callback)
    }
  }

  async start(settings: ProxySettings): Promise<void> {
    let operation: NetworkStartupFailure['operation'] = 'configure_upstream'
    try {
      await this.apply(settings)
      operation = 'listen'
      await this.#proxy.start()
    }
    catch (cause) {
      this.#startupError = new NetworkStartupError(operation, cause)
      this.#proxy.disconnect()
    }
    this.#sessionConfig = { mode: 'fixed_servers', proxyRules: this.#startupError ? this.proxyUrl : this.#proxy.address, proxyBypassRules: '<-loopback>' }
    app.on('login', this.#onLogin)
    app.on('session-created', this.#onSessionCreated)
    try {
      await Promise.all([app.setProxy(this.#sessionConfig), session.defaultSession.setProxy(this.#sessionConfig)])
    }
    catch (cause) {
      throw new NetworkStartupError('configure_sessions', cause)
    }
  }

  async apply(settings: ProxySettings): Promise<void> {
    if (this.#startupError)
      return
    if (settings.mode === this.#settings?.mode && settings.server === this.#settings.server)
      return
    const operation = this.#updating.then(async () => {
      await this.#resolver.setProxy(toElectronProxyConfig(settings))
      this.#settings = { ...settings }
      this.#proxy.disconnect()
    })
    this.#updating = operation.catch(() => {})
    await operation
  }

  async #resolve(url: string): Promise<string> {
    await this.#updating
    if (this.#startupError)
      throw this.#startupError
    if (this.#sessionFailure)
      throw this.#sessionFailure
    return this.#resolver.resolveProxy(url)
  }

  async stop(): Promise<void> {
    app.off('session-created', this.#onSessionCreated)
    app.off('login', this.#onLogin)
    await Promise.allSettled(this.#sessionSetup)
    await this.#proxy.stop()
    await this.#resolver.closeAllConnections()
  }
}
