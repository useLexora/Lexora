import type { LexoraConfig } from '../../shared/desktopApi'
import type { BrowserIntegration } from '../browser/BrowserIntegration'
import type { ExecuteDesktopCommand } from '../desktopCommands'
import type { DesktopTrayController } from '../tray'
import type { DesktopRuntimeHost } from './DesktopRuntimeHost'
import type { DesktopWindowHost } from './DesktopWindowHost'
import type { DesktopEnvironment } from './typing'
import { homedir } from 'node:os'
import process from 'node:process'
import { app, Notification, shell } from 'electron'
import { z } from 'zod'
import buddyVersion from '../../../buddy.version.json'
import { EXTENSION_REVIEW_REQUEST } from '../../../shared/extensions/extensionAuthoring'
import { spaceTextDocumentSchema } from '../../../shared/spaces/spaceFileApi'
import { registerBrowserDesktopIpc } from '../browser/registerBrowserDesktopIpc'
import { registerContextPanelIpc } from '../context-panel/registerContextPanelIpc'
import { createDesktopCommandExecutor } from '../desktopCommands'
import { DesktopNotificationService } from '../DesktopNotificationService'
import { checkForDesktopUpdate } from '../desktopUpdateService'
import { ApplicationLogReader } from '../diagnostics/ApplicationLogReader'
import { registerExtensionIpc } from '../extensions/registerExtensionIpc'
import { createFeedbackIssueUrl } from '../feedbackIssue'
import { registerDesktopIpc } from '../ipc'
import { registerLocalChatIpc } from '../localChatIpc'
import { createDesktopTray } from '../tray'
import { registerWorkbenchIpc } from '../workbench/registerWorkbenchIpc'
import { WorkbenchStateStore } from '../workbench/WorkbenchStateStore'
import { registerApplicationLogIpc } from './registerApplicationLogIpc'
import { registerStartupIpc } from './registerStartupIpc'

const browserArtifactEntrySchema = z.object({
  entryPath: z.string().min(1).max(32_768),
  rootPath: z.string().min(1).max(32_768),
}).strict()

export class DesktopIntegrations {
  readonly executeCommand: ExecuteDesktopCommand
  readonly #environment: DesktopEnvironment
  readonly #runtime: DesktopRuntimeHost
  readonly #windows: DesktopWindowHost
  readonly #browser: BrowserIntegration
  readonly #requestQuit: () => void
  readonly #subscriptions: Array<() => void | Promise<void>> = []
  #tray: DesktopTrayController | null = null

  constructor(environment: DesktopEnvironment, runtime: DesktopRuntimeHost, windows: DesktopWindowHost, browser: BrowserIntegration, requestQuit: () => void) {
    this.#environment = environment
    this.#runtime = runtime
    this.#windows = windows
    this.#browser = browser
    this.#requestQuit = requestQuit
    this.executeCommand = createDesktopCommandExecutor({
      getWindow: () => windows.window,
      isDeveloperToolsEnabled: () => runtime.config?.desktop.developerToolsEnabled ?? false,
      logDirectory: environment.paths.logs,
      openExternal: url => shell.openExternal(url),
      openPath: path => shell.openPath(path),
      requestQuit,
    })
  }

  async applyConfig(config: LexoraConfig): Promise<void> {
    this.#tray?.setLanguage(config.desktop.language)
    this.#windows.applyConfig(config)
    await this.#runtime.applyConfig(config)
    await this.#browser.host?.updateActivity()
  }

  start(): void {
    const { paths, trayIconPath, diagnostics } = this.#environment
    const runtime = this.#runtime
    const windows = this.#windows
    const service = runtime.service
    const extensions = registerExtensionIpc({
      home: paths.buddyHome,
      version: buddyVersion.version,
      developmentDirectory: !app.isPackaged && process.env.LEXORA_BUDDY_PROFILE === 'test' && process.env.LEXORA_HOME ? process.env.LEXORA_EXTENSION_DEVELOPMENT_PATH : undefined,
      getWindow: () => windows.window,
      get: runtime.network.get,
      notificationsEnabled: () => runtime.config?.desktop.notificationsEnabled ?? true,
      readText: async (target, signal) => spaceTextDocumentSchema.parse(await service.request('spaceFiles.readDocument', target, { signal })).text,
    })
    this.#subscriptions.push(extensions.dispose)
    this.#subscriptions.push(registerWorkbenchIpc(new WorkbenchStateStore(paths.buddyHome), () => windows.window))
    this.#subscriptions.push(registerContextPanelIpc(runtime.contextPanel, () => windows.window))
    this.#subscriptions.push(registerStartupIpc(this.#environment.startup, () => windows.window, this.#environment.events))
    this.#subscriptions.push(registerApplicationLogIpc(new ApplicationLogReader(paths.logs, diagnostics.launchId, homedir()), () => windows.window))
    this.#tray = createDesktopTray({
      appName: paths.appName,
      iconPath: trayIconPath,
      language: runtime.language,
      onOpenDesktop: () => windows.show(),
      onQuit: this.#requestQuit,
      runtime: service,
    })
    this.#subscriptions.push(service.onStateChange(state => this.#tray?.setRuntimeState(state)))
    const notifications = new DesktopNotificationService({
      createNotification(input) {
        const notification = new Notification(input)
        return { onClick: listener => notification.on('click', listener), show: () => notification.show() }
      },
      getLanguage: () => runtime.language,
      getSettings: () => ({
        notificationsEnabled: runtime.config?.desktop.notificationsEnabled ?? true,
        notifyWhenFocused: runtime.config?.desktop.notifyWhenFocused ?? false,
      }),
      isWindowFocused: () => windows.window?.isFocused() ?? false,
      openTarget: target => windows.openTarget(target),
      request: service.request.bind(service),
    })
    this.#subscriptions.push(service.onNotification((notification) => {
      if (notification.method === EXTENSION_REVIEW_REQUEST) {
        const input = z.object({ path: z.string().min(1).max(4096) }).strict().safeParse(notification.params)
        if (input.success) {
          void extensions.reviewPackage(input.data.path).catch((error) => {
            diagnostics.record({ scope: 'desktop', level: 'warn', event: 'extension.review.failed', error })
          })
        }
      }
      if (notification.method === 'desktop.open')
        windows.show()
      void notifications.handle(notification).catch((error) => {
        diagnostics.record({ scope: 'desktop', level: 'warn', event: 'notification.failed', error })
      })
    }))
    registerDesktopIpc({
      getSandboxStatus: () => this.#runtime.getSandboxStatus(),
      setupSandbox: () => this.#runtime.setupSandbox(),
      checkForUpdates: () => checkForDesktopUpdate({ currentVersion: app.getVersion(), fetchRelease: runtime.network.get }),
      configPath: paths.configPath,
      configStore: runtime.configStore,
      executeCommand: this.executeCommand,
      getWindow: () => windows.window,
      onConfigUpdated: config => this.applyConfig(config),
      openFeedbackIssue: feedback => shell.openExternal(createFeedbackIssueUrl(feedback)),
      openReleasePage: url => shell.openExternal(url),
    })
    this.#subscriptions.push(registerBrowserDesktopIpc({
      data: this.#browser.data,
      screenshots: this.#browser.screenshots,
      getHost: () => this.#browser.host,
      getWindow: () => windows.window,
      resolveArtifactEntry: async input => browserArtifactEntrySchema.parse(await service.request('artifacts.resolveBrowserEntry', input)),
    }))
    this.#subscriptions.push(registerLocalChatIpc({
      recordDiagnostic: this.#environment.events.scope({ component: 'desktop.gateway' }).publish,
      readWebCredential: () => runtime.readWebCredential(),
      getLanguage: () => runtime.language,
      getWindow: () => windows.window,
      openModelSnapshotDirectory: async () => {
        try {
          const error = await shell.openPath(paths.agentDirectory)
          if (error)
            throw new Error(error)
        }
        catch (error) {
          diagnostics.record({
            scope: 'desktop',
            component: 'desktop.gateway',
            level: 'warn',
            event: 'model_snapshot.directory_open.failed',
            errorCode: 'DIRECTORY_OPEN_FAILED',
          })
          throw error
        }
      },
      runtime: service,
    }))
  }

  async stopSubscriptions(): Promise<void> {
    for (const stop of this.#subscriptions.splice(0))
      await stop()
  }

  destroyTray(): void {
    this.#tray?.destroy()
    this.#tray = null
  }
}
