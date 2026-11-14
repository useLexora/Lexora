import type { BrowserWindow, Event } from 'electron'
import type { z } from 'zod'
import type { desktopOpenIntentSchema } from '../../../shared/service/localServiceProtocol'
import type { DesktopEnvironment } from './typing'
import process from 'node:process'
import { app, nativeTheme, powerMonitor } from 'electron'
import { z as schema } from 'zod'
import { currentPlatform } from '../../../platform/currentPlatform'
import { localTransports } from '../../../platform/ipc/localTransport'
import { DEFAULT_BROWSER_PREFERENCES } from '../../../shared/browser/browserPreferences'
import { readDiagnosticErrorCode } from '../../../shared/diagnostics/applicationDiagnostic'
import { ServiceHost } from '../../../shared/lifecycle/ServiceHost'
import { ServiceLifecycleSource } from '../../../shared/lifecycle/ServiceLifecycleSource'
import { observeLifecycleDiagnostics } from '../../../shared/observability/lifecycleDiagnostics'
import { runsRpc } from '../../../shared/runs/runApi'
import { BrowserIntegration } from '../browser/BrowserIntegration'
import { connectPlatformHost } from '../runtime/platformHostBootstrap'
import { RemoteServiceClient } from '../runtime/RemoteServiceClient'
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
import { initializeDesktopEnvironment, prepareDesktopEnvironment, prepareDesktopReady, registerDesktopSchemes } from './environment'
import { requestDesktopTarget } from './requestDesktopTarget'

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
  #openingDesktop: Promise<BrowserWindow> | undefined
  #closingDesktop: Promise<void> | undefined
  #locked = false

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
      endpoint: localTransports[currentPlatform.transport](environment.paths.browserAdapterSocket, { ownsProfileLease: () => true }),
      getPreferences: () => this.#runtime.config?.browser ?? DEFAULT_BROWSER_PREFERENCES,
      testBrokerSocketPath: environment.paths.profile === 'test' ? process.env.LEXORA_BUDDY_BROWSER_ADAPTER_TEST_BROKER_SOCKET : undefined,
    })
    this.#runtime = new DesktopRuntimeHost(environment, this.#windows, this.#browser)
    this.#runtime.openDesktop = (intent, signal) => this.#openDesktopTarget(intent, signal)
    this.#quit = createDesktopQuitLifecycle({
      events: environment.events,
      ...(environment.platformHost
        ? {
            getExitBehavior: () => this.#runtime.config?.desktop.exitBehavior ?? 'stop_service',
            closeDesktop: () => this.#closeDesktop(),
            restartDesktop: async () => {
              if (!(this.#runtime.service instanceof RemoteServiceClient))
                throw new Error('SERVICE_NOT_READY')
              await this.#runtime.service.restartDesktop()
            },
          }
        : {}),
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
          if (this.#runtime.service instanceof RemoteServiceClient)
            await this.#runtime.service.stop()
          await this.#dispose()
        }
        finally {
          await closeDesktopDiagnostics(environment.diagnostics)
        }
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
    app.on('activate', () => {
      void this.#openDesktop().catch(() => {})
    })
    app.on('window-all-closed', () => {})
    void app.whenReady().then(() => {
      powerMonitor.on('lock-screen', () => {
        this.#locked = true
      })
      powerMonitor.on('unlock-screen', () => {
        this.#locked = false
      })
    })
    const platformHost = this.#environment.platformHost
    if (platformHost) {
      platformHost.peer.onRequest('host.stop', async (raw) => {
        schema.object({}).strict().parse(raw)
        await this.#dispose()
        setImmediate(() => app.exit(0))
        return { stopped: true }
      })
      platformHost.peer.onDidClose(() => {
        void this.#dispose().finally(() => app.exit(1))
      })
    }
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
      await this.#runtime.publishHostReady()
      if (this.#environment.platformHost)
        return null
      return host.start('desktop.window', ({ defer }) => {
        defer(() => this.#windows.close())
        defer(() => this.#browser.closeWindow())
        return this.#openDesktop()
      }, ['desktop.integrations'])
    })
    if (window && this.#runtime.windowsPowerShell?.endsWith('\\powershell.exe') && !this.#environment.isSmokeTest)
      showLegacyPowerShellNotice(window, () => this.#runtime.language, this.#environment)
    if (this.#environment.isSmokeTest && window) {
      await checkDesktopSmokeBridge(window)
      await this.#runtime.verifyInstallation()
      await this.#quit.request()
    }
  }

  async #openDesktopTarget(intent: z.infer<typeof desktopOpenIntentSchema>, signal?: AbortSignal) {
    const available = () => !signal?.aborted && !this.#locked && powerMonitor.getSystemIdleState(1) !== 'locked' && !this.#quit.quitting && !this.#disposePromise && !this.#closingDesktop
    const unavailable = { accepted: false, uiReady: false, targetVisible: false, visible: false, focused: false }
    if (!available())
      return unavailable
    try {
      const window = await this.#openDesktop(intent)
      const targetVisible = await requestDesktopTarget(window, this.#environment.startup, intent, undefined, { signal, available })
      if (!available() || window.isDestroyed())
        return unavailable
      return { accepted: true, uiReady: this.#environment.startup.state.status === 'ready', targetVisible, visible: window.isVisible(), focused: window.isFocused() }
    }
    catch {
      return unavailable
    }
  }

  async #openDesktop(intent?: z.infer<typeof desktopOpenIntentSchema>): Promise<BrowserWindow> {
    if (this.#quit.quitting || this.#disposePromise || this.#closingDesktop || this.#locked)
      throw new Error('DESKTOP_OPEN_UNAVAILABLE')
    if (intent?.kind === 'tasks' && intent.conversationId) {
      const task = await this.#runtime.service.request('conversations.get', { conversationId: intent.conversationId })
      if (!task)
        throw new Error('CONVERSATION_NOT_FOUND')
    }
    const window = await (this.#openingDesktop ??= (async () => {
      await this.#runtime.setDesktopAvailable(true)
      this.#integrations.attachDesktop()
      if (this.#windows.window) {
        this.#windows.show()
        return this.#windows.window
      }
      const opened = await this.#windows.initialize({
        onWindowCreated: (window) => {
          this.#browser.bindWindow(window)
          window.on('query-session-end', () => {
            void this.#quit.request({ reason: 'session_end', discardDraftsOnFailure: true })
          })
        },
        onWindowReleasing: () => {
          this.#environment.startup.detachRenderer()
          this.#browser.closeWindow()
        },
        isQuitting: () => this.#quit.quitting,
        onHidden: () => {
          void showBackgroundCloseNotice(this.#runtime.configStore)
        },
        onRecoveryExhausted: () => this.#presentRendererRecovery(),
      })
      if (this.#environment.platformHost)
        this.#windows.show()
      return opened
    })().finally(() => {
      this.#openingDesktop = undefined
    }))
    if (this.#quit.quitting || this.#closingDesktop || window.isDestroyed())
      throw new Error('DESKTOP_OPEN_CANCELLED')
    return window
  }

  #closeDesktop(): Promise<void> {
    return this.#closingDesktop ??= (async () => {
      await this.#openingDesktop
      await this.#integrations.detachDesktop()
      this.#browser.closeWindow()
      this.#windows.close()
    })().finally(() => {
      this.#closingDesktop = undefined
    })
  }

  async handleStartupFailure(error: unknown): Promise<void> {
    if (this.#environment.platformHost) {
      this.#environment.startup.failed(error)
      await this.#dispose().catch(() => {})
      await closeDesktopDiagnostics(this.#environment.diagnostics)
      app.exit(1)
      return
    }
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
        finally {
          app.exit(1)
        }
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
      this.#browser.closeWindow()
      this.#windows.close()
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
    registerDesktopSchemes()
    if (isDesktopInstallationActive()) {
      app.quit()
      return
    }
    const platformHost = process.argv.includes('--lexora-platform-host') ? await connectPlatformHost() : undefined
    process.env.LEXORA_BUDDY_STORAGE_AUTHORITY ??= 'sqlite'
    environment = await prepareDesktopEnvironment(platformHost)
    if (environment.storage.state.pending) {
      await showStorageMigration(environment.storage, environment.diagnostics)
      return
    }
    if (process.argv.includes('--lexora-storage-maintenance')) {
      await closeDesktopDiagnostics(environment.diagnostics)
      app.exit(0)
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
    if (process.argv.includes('--lexora-platform-host')) {
      environment?.startup.failed(cause)
      if (environment)
        await closeDesktopDiagnostics(environment.diagnostics)
      app.exit(1)
      return
    }
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
