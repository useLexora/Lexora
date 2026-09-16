import type { AuthenticationResponseDetails, AuthInfo, Event, ProxyConfig, Session, WebContents } from 'electron'
import type { ProxySettings } from '../../../shared/network/proxySettings'
import { randomUUID } from 'node:crypto'
import { app, session } from 'electron'
import { OutboundProxy, toElectronProxyConfig } from './OutboundProxy'
import { requestThroughHost } from './requestThroughHost'

export class DesktopNetwork {
  readonly #resolver = session.fromPartition(`lexora-proxy-resolver:${randomUUID()}`, { cache: false })
  readonly #proxy = new OutboundProxy(url => this.#resolve(url))
  #settings: ProxySettings | null = null
  #updating: Promise<void> = Promise.resolve()
  #sessionConfig: ProxyConfig | null = null
  readonly #sessionSetup = new Set<Promise<void>>()
  #sessionFailure: unknown

  get proxyUrl(): string { return this.#proxy.url }
  get sandboxProxyUrl(): string { return this.#proxy.sandboxUrl }

  readonly get = (url: string, init?: Pick<RequestInit, 'headers' | 'signal'>): Promise<Response> => requestThroughHost(
    session.defaultSession,
    { url, method: 'GET', headers: Object.fromEntries(new Headers(init?.headers)) },
    init?.signal ?? AbortSignal.timeout(30_000),
    this.authenticateProxy,
  )

  readonly authenticateProxy = (authInfo: AuthInfo, callback: (username?: string, password?: string) => void): boolean => {
    if (!authInfo.isProxy || authInfo.host !== '127.0.0.1' || authInfo.port !== this.#proxy.port)
      return false
    callback(this.#proxy.username, this.#proxy.password)
    return true
  }

  readonly #onSessionCreated = (created: Session) => {
    if (!this.#sessionConfig || created === this.#resolver)
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
    await this.apply(settings)
    await this.#proxy.start()
    this.#sessionConfig = { mode: 'fixed_servers', proxyRules: this.#proxy.address, proxyBypassRules: '<-loopback>' }
    app.on('login', this.#onLogin)
    app.on('session-created', this.#onSessionCreated)
    await Promise.all([app.setProxy(this.#sessionConfig), session.defaultSession.setProxy(this.#sessionConfig)])
  }

  async apply(settings: ProxySettings): Promise<void> {
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
