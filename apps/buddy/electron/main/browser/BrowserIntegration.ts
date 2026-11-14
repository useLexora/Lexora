import type { BrowserWindow } from 'electron'
import type { LocalEndpoint } from '../../../platform/ipc/localTransport'
import type { DesktopBrowserPresentationInput } from '../../../shared/browser/browserDesktopApi'
import type { BrowserPreferences } from '../../../shared/browser/browserPreferences'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { BrowserAdapterServer } from './BrowserAdapterServer'
import { BrowserAdapterTestLeasePublisher } from './BrowserAdapterTestLeasePublisher'
import { BrowserDataService } from './BrowserDataService'
import { BrowserHost } from './BrowserHost'
import { BrowserOperationGuard } from './BrowserOperationGuard'
import { BrowserPresentationHost } from './BrowserPresentationHost'
import { BrowserScreenshotService } from './BrowserScreenshotService'

interface BrowserIntegrationOptions {
  isTaskLinked?: () => boolean
  onActivityError?: () => void
  endpoint: LocalEndpoint
  getPreferences: () => BrowserPreferences
  testBrokerSocketPath?: string
  report?: ApplicationDiagnosticReporter
}

export class BrowserIntegration {
  readonly adapter: BrowserAdapterServer
  readonly data: BrowserDataService
  readonly screenshots: BrowserScreenshotService
  readonly #presentation = new BrowserPresentationHost((sessionId, visible) => this.#host?.setSurface({ sessionId, visible }))
  #window: BrowserWindow | null = null
  readonly #operations = new BrowserOperationGuard()
  #host: BrowserHost | null = null
  #adapterStarted = false
  #testLeasePublisher: BrowserAdapterTestLeasePublisher | null = null
  readonly #closingHosts = new Set<Promise<void>>()

  readonly #options: BrowserIntegrationOptions

  constructor(options: BrowserIntegrationOptions) {
    this.#options = options
    this.adapter = new BrowserAdapterServer({ getHost: () => this.host, endpoint: options.endpoint })
    this.data = new BrowserDataService(() => this.host, this.#operations)
    this.screenshots = new BrowserScreenshotService(options.getPreferences)
  }

  get host(): BrowserHost | null {
    return this.#host?.isDisposed ? null : this.#host
  }

  bindWindow(window: BrowserWindow): void {
    this.#window = window
    this.#presentation.bindWindow(window)
  }

  acquirePresentation(window: BrowserWindow): string {
    return this.#presentation.acquire(window)
  }

  async present(window: BrowserWindow, input: DesktopBrowserPresentationInput): Promise<string | null> {
    if (this.host?.getState(input.sessionId).pageId !== input.pageId)
      throw new Error('BROWSER_PAGE_FAILED')
    return this.#presentation.present(window, input)
  }

  #startHost(): void {
    if (this.host)
      return
    this.#host = new BrowserHost({
      getFreezeDelay: (visible) => {
        if (!this.#options.isTaskLinked?.())
          return null
        const preferences = this.#options.getPreferences()
        return (visible ? preferences.freezeForeground : preferences.freezeBackground)
          ? preferences.freezeDelaySeconds * 1000
          : null
      },
      onActivityError: this.#options.onActivityError,
      createPage: descriptor => this.#presentation.createPage(descriptor),
      operations: this.#operations,
      getDefaultZoomFactor: () => this.#options.getPreferences().defaultZoomFactor,
      requestGuestAttachment: () => {
        this.#send(DESKTOP_IPC_CHANNELS.browserGuestsChanged)
      },
      revokeSession: id => this.adapter.revokeSession(id),
    })
    this.#host.onDidChange((change) => {
      if (change.kind === 'session' || (change.kind === 'guest' && change.status === 'detached'))
        this.#send(DESKTOP_IPC_CHANNELS.browserGuestsChanged)
    })
    this.#host.onDidChange((change) => {
      if (change.kind === 'state') {
        if (!change.state.visible)
          this.#presentation.hide(change.state.sessionId)
        this.#send(DESKTOP_IPC_CHANNELS.browserStateChanged, change.state)
      }
    })
    this.#host.onDidChange((change) => {
      if (change.kind === 'state')
        this.#testLeasePublisher?.publish(structuredClone(change.state))
    })
    this.#host.onDidChange((change) => {
      if (change.kind === 'state')
        return
      const sessionId = change.kind === 'session' ? change.state.sessionId : change.sessionId
      const common = { sessionId, revision: change.revision, component: 'desktop.browser' }
      if (change.kind === 'timing') {
        this.#options.report?.({ ...common, event: `browser.timing.${change.phase}`, level: 'info', durationMs: change.durationMs })
      }
      else if (change.kind === 'action') {
        this.#options.report?.({ ...common, event: `browser.action.${change.phase}${change.phase === 'failed' ? `.${change.effect.replaceAll('-', '_')}` : ''}`, level: change.phase === 'failed' ? 'warn' : 'info', operationId: change.operationId, method: change.action, ...(change.errorCode ? { errorCode: change.errorCode } : {}) })
      }
      else {
        this.#options.report?.({ ...common, event: `browser.${change.kind}.${change.kind === 'control' ? change.controller : change.status}`, level: 'info' })
      }
    })
  }

  closeWindow(): void {
    this.#presentation.detachWindow()
    this.#window = null
  }

  #send(channel: string, value?: unknown): void {
    const window = this.#window
    if (window && !window.isDestroyed())
      window.webContents.send(channel, value)
  }

  #stopHost(): void {
    const host = this.#host
    host?.dispose()
    if (host) {
      const pending = host.whenIdle().finally(() => this.#closingHosts.delete(pending))
      this.#closingHosts.add(pending)
    }
    this.#host = null
  }

  async startAdapter(): Promise<void> {
    this.#startHost()
    await this.adapter.start()
    this.#adapterStarted = true
    if (this.#options.testBrokerSocketPath) {
      this.#testLeasePublisher = new BrowserAdapterTestLeasePublisher({
        brokerSocketPath: this.#options.testBrokerSocketPath,
        issueLease: input => this.adapter.issueLease(input),
      })
    }
  }

  async stopAdapter(): Promise<void> {
    this.#stopHost()
    await Promise.all([...this.#closingHosts])
    this.#testLeasePublisher?.dispose()
    this.#testLeasePublisher = null
    if (this.#adapterStarted) {
      this.#adapterStarted = false
      await this.adapter.dispose()
    }
    this.#presentation.dispose()
  }
}
