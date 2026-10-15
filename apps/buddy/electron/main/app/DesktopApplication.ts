import type { Event } from 'electron'
import type { DesktopEnvironment } from './typing'
import process from 'node:process'
import { app, nativeTheme } from 'electron'
import { currentPlatform } from '../../../platform/currentPlatform'
import { localTransports } from '../../../platform/ipc/localTransport'
import { DEFAULT_BROWSER_PREFERENCES } from '../../../shared/browser/browserPreferences'
import { readDiagnosticErrorCode } from '../../../shared/diagnostics/applicationDiagnostic'
import { ServiceHost } from '../../../shared/lifecycle/ServiceHost'
import { ServiceLifecycleSource } from '../../../shared/lifecycle/ServiceLifecycleSource'
import { observeLifecycleDiagnostics } from '../../../shared/observability/lifecycleDiagnostics'
import { runsRpc } from '../../../shared/runs/runApi'
import { BrowserIntegration } from '../browser/BrowserIntegration'
import { INSTALLER_EXIT_ARGUMENT, isInstallerExitRequest, resolveDesktopLaunchIntent } from '../startupIntent'
import { showStorageMigration } from '../storage/StorageMigrationWindow'
import { showStorageUnavailable, StorageUnavailableError } from '../storage/storageUnavailable'
import { isDesktopInstallationActive } from '../updates/desktopInstallationGate'
import { closeDesktopDiagnostics } from './closeDesktopDiagnostics'
import { confirmDesktopQuit, showBackgroundCloseNotice, showDesktopStartupFailure, showLegacyPowerShellNotice } from './desktopDialogs'
import { DesktopIntegrations } from './DesktopIntegrations'
import { describeProcessExit } from './desktopProcessDiagnostics'
import { createDesktopQuitLifecycle } from './desktopQuitLifecycle'
import { readPreviousLaunchId, recoveryRelaunchArgs } from './desktopRecovery'
import { showDesktopRendererRecovery } from './desktopRendererRecovery'
import { DesktopRuntimeHost } from './DesktopRuntimeHost'
import { checkDesktopSmokeBridge } from './desktopSmokeCheck'
import { checkDesktopDirectories, DesktopInstanceLockUnavailable } from './desktopStorage'
import { DesktopWindowHost } from './DesktopWindowHost'
import { initializeDesktopEnvironment, prepareDesktopEnvironment, prepareDesktopReady } from './environment'

class DesktopApplication {
  readonly #environment: DesktopEnvironment
  readonly #windows: DesktopWindowHost
  readonly #browser: BrowserIntegration
  readonly #runtime: DesktopRuntimeHost
  readonly #integrations: DesktopIntegrations
  readonly #host: ServiceHost
  readonly #lifecycleSubscriptions: (() => void)[]
  readonly #quit: ReturnType<typeof createDesktopQuitLifecycle>
  #disposePromise: Promise<void> | null = null
  #rendererRecoveryPrompt: Promise<void> | null = null

  constructor(environment: DesktopEnvironment) {
    this.#environment = environment
    this.#host = new ServiceHost(new ServiceLifecycleSource(() => environment.events.publish({ event: 'observer.failed', component: 'desktop.lifecycle', level: 'warn' })))
    this.#lifecycleSubscriptions = [
      environment.startup.bindDesktop(this.#host.lifecycle),
      observeLifecycleDiagnostics(this.#host.lifecycle, environment.events),
    ]
    this.#windows = new DesktopWindowHost(environment)
    this.#browser = new BrowserIntegration({
      report: event => environment.events.publish(event),
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
        isBusy: async () => {
          if (this.#runtime.service.state.status !== 'ready')
            return false
          return runsRpc.isBusy.response.parse(await this.#runtime.service.request(runsRpc.isBusy.method, {}, { timeoutMs: 5_000 }))
        },
      }, options),
      dispose: async () => {
        try {
          await this.#dispose()
        }
        finally { await closeDesktopDiagnostics(environment.diagnostics) }
      },
      quit: (restart) => {
        if (restart)
          app.relaunch({ args: recoveryRelaunchArgs(process.argv, environment.diagnostics.launchId) })
        app.quit()
      },
      exit: () => app.exit(1),
    })
    this.#integrations = new DesktopIntegrations(environment, this.#runtime, this.#windows, this.#browser, () => this.#requestQuit(), () => this.#requestRestart(), async (prepare) => {
      let prepared = false
      await this.#quit.request({ reason: 'installation' }, async () => {
        const finish = await prepare()
        prepared = true
        return finish
      })
      return prepared && this.#quit.committed
    })
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
        if (!this.#quit.quitting)
          this.#environment.events.publish({ level: 'error', event: 'app.interrupt_failed', errorCode: readDiagnosticErrorCode(error) })
        await closeDesktopDiagnostics(this.#environment.diagnostics)
        app.exit(1)
      })
    })
    app.on('before-quit', (event: Event) => {
      if (this.#quit.committed)
        return
      event.preventDefault()
      this.#requestQuit()
    })
    app.on('second-instance', (_event, argv, _directory, data) => {
      this.#environment.events.publish({ level: 'info', event: 'app.second_instance' })
      if (process.platform === 'win32' && isInstallerExitRequest(argv, data, process.execPath)) {
        void this.#quit.request({ reason: 'installation' }).catch((error) => {
          this.#environment.events.publish({ level: 'error', event: 'app.installation_quit_failed', errorCode: readDiagnosticErrorCode(error) })
        })
        return
      }
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
      await host.start('desktop.integrations', async ({ defer }) => {
        defer(() => this.#integrations.destroyTray())
        defer(() => this.#integrations.stopSubscriptions())
        await this.#integrations.start()
      }, ['desktop.runtime'])
      return host.start('desktop.window', ({ defer }) => {
        defer(() => this.#windows.close())
        defer(() => this.#browser.closeWindow())
        return this.#windows.initialize({
          onWindowCreated: window => this.#browser.bindWindow(window),
          isQuitting: () => this.#quit.quitting,
          onHidden: () => { void showBackgroundCloseNotice(this.#runtime.configStore) },
          onRecoveryExhausted: () => this.#presentRendererRecovery(),
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
          await closeDesktopDiagnostics(this.#environment.diagnostics)
        }
        finally { app.exit(1) }
      }
    }
  }

  #requestQuit(): void {
    void this.#quit.request().catch((error) => {
      if (!this.#quit.quitting)
        this.#environment.events.publish({ level: 'error', event: 'app.stop_failed', errorCode: readDiagnosticErrorCode(error) })
    })
  }

  #requestRestart(): void {
    void this.#quit.request({ restart: true }).catch((error) => {
      if (!this.#quit.quitting)
        this.#environment.events.publish({ level: 'error', event: 'app.restart_failed', errorCode: readDiagnosticErrorCode(error) })
    })
  }

  #presentRendererRecovery(): void {
    if (this.#quit.quitting || this.#rendererRecoveryPrompt)
      return
    this.#rendererRecoveryPrompt = showDesktopRendererRecovery(
      this.#runtime.language,
      this.#environment,
      async () => {
        await this.#quit.request({ discardDraftsOnFailure: true, restart: true })
        return this.#quit.committed
      },
      async () => {
        await this.#quit.request({ discardDraftsOnFailure: true })
        return this.#quit.committed
      },
    ).catch((error) => {
      this.#environment.events.publish({ level: 'error', event: 'renderer.recovery.dialog_failed', errorCode: readDiagnosticErrorCode(error) })
    }).finally(() => {
      this.#rendererRecoveryPrompt = null
    })
  }

  #dispose(): Promise<void> {
    this.#disposePromise ??= (async () => {
      this.#environment.startup.stopping()
      const failures: unknown[] = []
      try {
        await this.#host.stop()
      }
      catch (error) {
        failures.push(error)
      }
      const failure = failures.length ? new AggregateError(failures, 'Desktop application cleanup failed') : undefined
      this.#environment.startup.stopped(failure)
      for (const stop of this.#lifecycleSubscriptions)
        stop()
      if (failure)
        throw failure
    })()
    return this.#disposePromise
  }
}

export async function startDesktopApplication(): Promise<void> {
  let environment: DesktopEnvironment | undefined
  let recoveryRecorded = false
  try {
    if (isDesktopInstallationActive()) {
      app.quit()
      return
    }
    environment = prepareDesktopEnvironment()
    if (environment.storage.state.pending) {
      await showStorageMigration(environment.storage, environment.diagnostics)
      return
    }
    initializeDesktopEnvironment(environment)
    if (process.argv.includes(INSTALLER_EXIT_ARGUMENT)) {
      await closeDesktopDiagnostics(environment.diagnostics)
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
  catch (cause) {
    let error = cause
    if (error instanceof StorageUnavailableError) {
      await showStorageUnavailable(error)
      return
    }
    if (error instanceof DesktopInstanceLockUnavailable) {
      try {
        await checkDesktopDirectories({ user_data: error.userData })
        app.quit()
        return
      }
      catch (failure) {
        error = failure
      }
    }
    const previousLaunchId = readPreviousLaunchId(process.argv)
    if (previousLaunchId && !recoveryRecorded)
      environment?.events.publish({ level: 'info', event: 'app.recovery_started', previousLaunchId })
    environment?.startup.failed(error)
    const failedEnvironment = environment
    void showDesktopStartupFailure(error, 'zh-CN', environment, failedEnvironment ? () => prepareDesktopReady(failedEnvironment) : undefined).finally(async () => {
      try {
        if (environment)
          await closeDesktopDiagnostics(environment.diagnostics)
      }
      finally {
        app.exit(1)
      }
    })
  }
}
