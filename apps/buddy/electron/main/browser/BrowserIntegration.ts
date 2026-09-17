import type { BrowserWindow } from 'electron'
import type { LocalEndpoint } from '../../../platform/ipc/localTransport'
import type { BrowserPreferences } from '../../../shared/browser/browserPreferences'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { BrowserAdapterServer } from './BrowserAdapterServer'
import { BrowserAdapterTestLeasePublisher } from './BrowserAdapterTestLeasePublisher'
import { BrowserDataService } from './BrowserDataService'
import { BrowserHost } from './BrowserHost'
import { BrowserOperationGuard } from './BrowserOperationGuard'
import { BrowserScreenshotService } from './BrowserScreenshotService'

interface BrowserIntegrationOptions {
  isTaskLinked?: () => boolean
  onActivityError?: () => void
  endpoint: LocalEndpoint
  getPreferences: () => BrowserPreferences
  testBrokerSocketPath?: string
}

export class BrowserIntegration {
  readonly adapter: BrowserAdapterServer
  readonly data: BrowserDataService
  readonly screenshots: BrowserScreenshotService
  readonly #operations = new BrowserOperationGuard()
  #host: BrowserHost | null = null
  #adapterStarted = false
  #testLeasePublisher: BrowserAdapterTestLeasePublisher | null = null

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
    this.closeWindow()
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
      window,
      operations: this.#operations,
      getDefaultZoomFactor: () => this.#options.getPreferences().defaultZoomFactor,
      onGuestSetChanged: () => {
        if (!window.isDestroyed())
          window.webContents.send(DESKTOP_IPC_CHANNELS.browserGuestsChanged)
      },
      onSessionClosed: state => this.adapter.revokeSession(state.sessionId),
      onStateChanged: (state) => {
        this.#testLeasePublisher?.publish(state)
        if (!window.isDestroyed())
          window.webContents.send(DESKTOP_IPC_CHANNELS.browserStateChanged, state)
      },
    })
  }

  closeWindow(): void {
    this.#host?.dispose()
    this.#host = null
  }

  async startAdapter(): Promise<void> {
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
    this.#testLeasePublisher?.dispose()
    this.#testLeasePublisher = null
    if (this.#adapterStarted) {
      this.#adapterStarted = false
      await this.adapter.dispose()
    }
  }
}
