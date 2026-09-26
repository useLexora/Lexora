import type { Event } from 'electron'
import type { DesktopEnvironment } from './typing'
import process from 'node:process'
import { app, nativeTheme } from 'electron'
import { currentPlatform } from '../../../platform/currentPlatform'
import { localTransports } from '../../../platform/ipc/localTransport'
import { DEFAULT_BROWSER_PREFERENCES } from '../../../shared/browser/browserPreferences'
import { readDiagnosticErrorCode } from '../../../shared/diagnostics/applicationDiagnostic'
import { ServiceHost } from '../../../shared/lifecycle/ServiceHost'
import { BrowserIntegration } from '../browser/BrowserIntegration'
import { resolveDesktopLaunchIntent } from '../startupIntent'
import { confirmDesktopQuit, showBackgroundCloseNotice, showDesktopStartupFailure, showLegacyPowerShellNotice } from './desktopDialogs'
import { DesktopIntegrations } from './DesktopIntegrations'
import { describeProcessExit } from './desktopProcessDiagnostics'
import { createDesktopQuitLifecycle } from './desktopQuitLifecycle'
import { readPreviousLaunchId } from './desktopRecovery'
import { DesktopRuntimeHost } from './DesktopRuntimeHost'
import { checkDesktopSmokeBridge } from './desktopSmokeCheck'
import { DesktopWindowHost } from './DesktopWindowHost'
import { checkDesktopCoreDirectories, initializeDesktopEnvironment, prepareDesktopEnvironment, prepareDesktopReady } from './environment'

class DesktopApplication {
  readonly #environment: DesktopEnvironment
  readonly #windows: DesktopWindowHost
  readonly #browser: BrowserIntegration
  readonly #runtime: DesktopRuntimeHost
  readonly #integrations: DesktopIntegrations
  readonly #host: ServiceHost
  readonly #quit: ReturnType<typeof createDesktopQuitLifecycle>
  #disposePromise: Promise<void> | null = null

  constructor(environment: DesktopEnvironment) {
    this.#environment = environment
    this.#host = new ServiceHost(environment.events)
    this.#windows = new DesktopWindowHost(environment)
    this.#browser = new BrowserIntegration({
      isTaskLinked: () => this.#runtime.config?.desktop.contextPanelMode === 'task',
      onActivityError: () => environment.events.publish({ level: 'warn', event: 'browser.activity.failed', errorCode: 'BROWSER_ACTIVITY_FAILED' }),
      endpoint: localTransports[currentPlatform.transport](environment.paths.browserAdapterSocket),
      getPreferences: () => this.#runtime.config?.browser ?? DEFAULT_BROWSER_PREFERENCES,
      testBrokerSocketPath: environment.paths.profile === 'test' ? process.env.LEXORA_BUDDY_BROWSER_ADAPTER_TEST_BROKER_SOCKET : undefined,
    })
    this.#runtime = new DesktopRuntimeHost(environment, this.#windows, this.#browser)
    this.#quit = createDesktopQuitLifecycle({
      events: environment.events,
      confirm: options => confirmDesktopQuit({
        getWindow: () => this.#windows.window,
        getLanguage: () => this.#runtime.language,
      }, options),
      dispose: async () => {
        try {
          await this.#dispose()
        }
        finally { await environment.diagnostics.close() }
      },
      quit: () => app.quit(),
    })
    this.#integrations = new DesktopIntegrations(environment, this.#runtime, this.#windows, this.#browser, () => this.#requestQuit())
  }

  bindEvents(): void {
    app.on('child-process-gone', (_event, details) => {
      this.#environment.events.publish({
        level: details.reason === 'clean-exit' ? 'info' : 'error',
        event: 'process.exited',
        processExit: describeProcessExit(details.type === 'GPU' ? 'gpu' : details.type === 'Utility' ? 'utility' : 'other', details),
      })
    })
    nativeTheme.on('updated', () => this.#windows.updateAppearance())
    process.once('SIGINT', () => {
      void this.#quit.request({ discardDraftsOnFailure: true }).catch(async (error) => {
        this.#environment.events.publish({ level: 'error', event: 'app.interrupt_failed', errorCode: readDiagnosticErrorCode(error) })
        await this.#environment.diagnostics.close()
        app.exit(1)
      })
    })
    app.on('before-quit', (event: Event) => {
      if (this.#quit.committed)
        return
      event.preventDefault()
      this.#requestQuit()
    })
    app.on('second-instance', (_event, argv) => {
      this.#environment.events.publish({ level: 'info', event: 'app.second_instance' })
      if (resolveDesktopLaunchIntent(argv) === 'foreground')
        this.#windows.show()
    })
    app.on('activate', () => this.#windows.show())
    app.on('window-all-closed', () => {})
  }

  async start(): Promise<void> {
    const host = this.#host
    const window = await host.start('desktop', async () => {
      await host.step('desktop.electron', () => app.whenReady())
      await host.step('desktop.environment', () => prepareDesktopReady(this.#environment), ['desktop.electron'])
      await host.start('desktop.browser_adapter', ({ defer }) => {
        defer(() => this.#browser.stopAdapter())
        return this.#browser.startAdapter()
      }, ['desktop.environment'])
      const config = await host.start('desktop.runtime', ({ defer }) => {
        defer(() => this.#runtime.stop())
        return this.#runtime.prepare()
      }, ['desktop.browser_adapter'])
      await host.step('desktop.features', () => this.#integrations.applyConfig(config), ['desktop.runtime'])
      this.#runtime.start()
      await host.start('desktop.integrations', ({ defer }) => {
        defer(() => this.#integrations.destroyTray())
        defer(() => this.#integrations.stopSubscriptions())
        this.#integrations.start()
      }, ['desktop.runtime'])
      return host.start('desktop.window', ({ defer }) => {
        defer(() => this.#windows.close())
        defer(() => this.#browser.closeWindow())
        return this.#windows.initialize({
          onWindowCreated: window => this.#browser.bindWindow(window),
          isQuitting: () => this.#quit.quitting,
          minimizeToTrayOnClose: () => this.#runtime.config?.desktop.minimizeToTrayOnClose ?? true,
          onCloseToQuit: () => this.#requestQuit(),
          onHidden: () => { void showBackgroundCloseNotice(this.#runtime.configStore) },
        })
      }, ['desktop.integrations'])
    })
    if (this.#runtime.windowsPowerShell?.endsWith('\\powershell.exe') && !this.#environment.isSmokeTest)
      showLegacyPowerShellNotice(window, () => this.#runtime.language, this.#environment)
    if (this.#environment.isSmokeTest) {
      await checkDesktopSmokeBridge(window)
      await this.#runtime.verifyInstallation()
      await this.#quit.request()
    }
  }

  async handleStartupFailure(error: unknown): Promise<void> {
    if (this.#environment.isSmokeTest)
      process.stderr.write(`Desktop installation verification failed: ${error instanceof Error ? error.stack : String(error)}\n`)
    this.#environment.startup.failed(error)
    try {
      await this.#dispose()
    }
    catch {}
    finally {
      try {
        if (!this.#environment.isSmokeTest)
          await showDesktopStartupFailure(error, this.#runtime.language, this.#environment, () => prepareDesktopReady(this.#environment))
      }
      finally {
        try {
          await this.#environment.diagnostics.close()
        }
        finally { app.exit(1) }
      }
    }
  }

  #requestQuit(): void {
    void this.#quit.request().catch((error) => {
      this.#environment.events.publish({ level: 'error', event: 'app.stop_failed', errorCode: readDiagnosticErrorCode(error) })
      if (this.#quit.quitting)
        app.exit(1)
    })
  }

  #dispose(): Promise<void> {
    this.#disposePromise ??= (async () => {
      this.#environment.events.publish({ level: 'info', event: 'app.stopping' })
      this.#environment.startup.stopping()
      const failures: unknown[] = []
      try {
        await this.#host.stop()
      }
      catch (error) {
        failures.push(error)
      }
      this.#environment.events.publish({ level: failures.length ? 'error' : 'info', event: failures.length ? 'app.stop_failed' : 'app.stopped' })
      this.#environment.startup.stopped()
      if (failures.length)
        throw new AggregateError(failures, 'Desktop application cleanup failed')
    })()
    return this.#disposePromise
  }
}

export async function startDesktopApplication(): Promise<void> {
  let environment: DesktopEnvironment | undefined
  let recoveryRecorded = false
  try {
    environment = prepareDesktopEnvironment()
    initializeDesktopEnvironment(environment)
    if (!app.requestSingleInstanceLock()) {
      environment.diagnostics.record({ scope: 'desktop', level: 'info', event: 'startup.single_instance_lock_unavailable' })
      await checkDesktopCoreDirectories(environment)
      await environment.diagnostics.close()
      app.quit()
      return
    }
    environment.events.publish({ level: 'info', event: 'app.starting' })
    const previousLaunchId = readPreviousLaunchId(process.argv)
    if (previousLaunchId) {
      environment.events.publish({ level: 'info', event: 'app.recovery_started', previousLaunchId })
      recoveryRecorded = true
    }
    const application = new DesktopApplication(environment)
    application.bindEvents()
    void application.start().catch(error => application.handleStartupFailure(error))
  }
  catch (error) {
    const previousLaunchId = readPreviousLaunchId(process.argv)
    if (previousLaunchId && !recoveryRecorded)
      environment?.events.publish({ level: 'info', event: 'app.recovery_started', previousLaunchId })
    environment?.startup.failed(error)
    const failedEnvironment = environment
    void showDesktopStartupFailure(error, 'zh-CN', environment, failedEnvironment ? () => prepareDesktopReady(failedEnvironment) : undefined).finally(async () => {
      try {
        await environment?.diagnostics.close()
      }
      finally {
        app.exit(1)
      }
    })
  }
}
