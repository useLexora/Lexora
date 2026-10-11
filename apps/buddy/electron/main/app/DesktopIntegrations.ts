import type { LexoraConfig } from '../../shared/desktopApi'
import type { BrowserIntegration } from '../browser/BrowserIntegration'
import type { ExecuteDesktopCommand } from '../desktopCommands'
import type { DesktopTrayController } from '../tray'
import type { DesktopRuntimeHost } from './DesktopRuntimeHost'
import type { DesktopWindowHost } from './DesktopWindowHost'
import type { DesktopEnvironment } from './typing'
import { homedir } from 'node:os'
import process from 'node:process'
import { app, nativeTheme, Notification, shell } from 'electron'
import { z } from 'zod'
import buddyVersion from '../../../buddy.version.json'
import { ThemeService } from '../../../platform/themes/ThemeService'
import { CONVERSATION_CHANGED, conversationSchema } from '../../../shared/conversation/conversationApi'
import { extensionActionRpc } from '../../../shared/extensions/extensionActionApi'
import { extensionAgentRpc } from '../../../shared/extensions/extensionAgent'
import { extensionJsonSchema } from '../../../shared/extensions/extensionApi'
import { EXTENSION_REVIEW_REQUEST } from '../../../shared/extensions/extensionAuthoring'
import { extensionConditionSnapshotRpc } from '../../../shared/extensions/extensionConditionContext'
import { providerNotifications } from '../../../shared/providers/providerApi'
import { runNotifications } from '../../../shared/runs/runApi'
import { spaceTextDocumentSchema } from '../../../shared/spaces/spaceFileApi'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { registerBrowserDesktopIpc } from '../browser/registerBrowserDesktopIpc'
import { registerContextPanelIpc } from '../context-panel/registerContextPanelIpc'
import { createDesktopCommandExecutor } from '../desktopCommands'
import { DesktopNotificationService } from '../DesktopNotificationService'
import { ApplicationLogReader } from '../diagnostics/ApplicationLogReader'
import { registerExtensionIpc } from '../extensions/registerExtensionIpc'
import { createFeedbackIssueUrl } from '../feedbackIssue'
import { registerDesktopIpc } from '../ipc'
import { registerLocalChatIpc } from '../localChatIpc'
import { registerThemeIpc } from '../themes/registerThemeIpc'
import { createDesktopTray } from '../tray'
import { registerDesktopUpdates } from '../updates/registerDesktopUpdates'
import { registerWorkbenchIpc } from '../workbench/registerWorkbenchIpc'
import { WorkbenchStateStore } from '../workbench/WorkbenchStateStore'
import { registerApplicationLogIpc } from './registerApplicationLogIpc'
import { registerPerformanceIpc } from './registerPerformanceIpc'
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
  readonly #requestRestart: () => void
  readonly #subscriptions: Array<() => void | Promise<void>> = []
  #tray: DesktopTrayController | null = null

  constructor(environment: DesktopEnvironment, runtime: DesktopRuntimeHost, windows: DesktopWindowHost, browser: BrowserIntegration, requestQuit: () => void, requestRestart: () => void) {
    this.#environment = environment
    this.#runtime = runtime
    this.#windows = windows
    this.#browser = browser
    this.#requestQuit = requestQuit
    this.#requestRestart = requestRestart
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

  async start(): Promise<void> {
    const { paths, trayIconPath, diagnostics } = this.#environment
    const runtime = this.#runtime
    const windows = this.#windows
    const service = runtime.service
    const themes = new ThemeService(paths.buddyHome, async (preference, assertCurrent) => {
      await runtime.configStore.update({ desktop: { theme: preference } }, config => this.applyConfig(config), assertCurrent)
    }, {
      readSystemDark: () => {
        nativeTheme.themeSource = 'system'
        return nativeTheme.shouldUseDarkColors
      },
      record: this.#environment.events.publish,
    })
    this.#subscriptions.push(runtime.configStore.onDidChange((change) => {
      if (change.kind === 'committed')
        themes.applyPreference(change.config.desktop.theme)
    }).dispose)
    this.#subscriptions.push(() => themes.dispose())
    await themes.initialize(runtime.config!.desktop.theme, nativeTheme.shouldUseDarkColors)
    const extensions = registerExtensionIpc({
      themes,
      record: this.#environment.events.publish,
      home: paths.buddyHome,
      version: buddyVersion.version,
      developmentDirectory: !app.isPackaged && paths.profile === 'test' ? process.env.LEXORA_EXTENSION_DEVELOPMENT_PATH : undefined,
      getWindow: () => windows.window,
      get: runtime.network.get,
      notificationsEnabled: () => runtime.config?.desktop.notificationsEnabled ?? true,
      conditionRuntime: async (input, signal) => extensionConditionSnapshotRpc.response.parse(await service.request(extensionConditionSnapshotRpc.method, input, { signal, timeoutMs: 5000 })),
      taskActions: async () => extensionActionRpc.list.response.parse(await service.request(extensionActionRpc.list.method, {})),
      invokeTaskAction: async input => extensionActionRpc.invoke.response.parse(await service.request(extensionActionRpc.invoke.method, input, { timeoutMs: null })),
      agentChanged: catalog => service.notify(extensionAgentRpc.changed, catalog),
      agentRequest: async (input, signal) => extensionJsonSchema.parse(await service.request(extensionAgentRpc.request, input, { signal, timeoutMs: 120000 })),
      readText: async (target, signal) => spaceTextDocumentSchema.parse(await service.request('spaceFiles.readDocument', target, { signal })).text,
    })
    this.#subscriptions.push(extensions.dispose)
    await extensions.themesReady.catch(() => {})
    this.#subscriptions.push(registerThemeIpc(themes, () => windows.window, (color, dark, system) => windows.setThemeAppearance(color, dark, system)))
    this.#subscriptions.push(service.onStateChange(() => extensions.conditions.invalidate({ inputs: ['runtime.models', 'runtime.task'] })))
    runtime.inspectExtension = extensions.inspect
    runtime.extensionAgent = extensions.agent
    this.#subscriptions.push(() => {
      runtime.inspectExtension = null
      runtime.extensionAgent = null
    })
    this.#subscriptions.push(registerWorkbenchIpc(new WorkbenchStateStore(paths.buddyHome), () => windows.window))
    this.#subscriptions.push(registerContextPanelIpc(runtime.contextPanel, () => windows.window))
    this.#subscriptions.push(registerStartupIpc(this.#environment.startup, () => windows.window))
    this.#subscriptions.push(registerApplicationLogIpc(new ApplicationLogReader(paths.logs, diagnostics.launchId, homedir()), () => windows.window, event => diagnostics.record(event), () => diagnostics.flushWithin(1000)))
    this.#subscriptions.push(registerPerformanceIpc(runtime, () => windows.window, this.#environment.events.publish))
    this.#tray = createDesktopTray({
      appName: paths.appName,
      iconPath: trayIconPath,
      language: runtime.language,
      onOpenDesktop: () => windows.show(),
      onQuit: this.#requestQuit,
      onRestart: this.#requestRestart,
    })
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
      if (notification.method === providerNotifications.changed.method)
        extensions.conditions.invalidate({ inputs: ['runtime.models'] })
      if (notification.method === CONVERSATION_CHANGED) {
        const task = conversationSchema.safeParse(notification.params)
        if (task.success)
          extensions.conditions.invalidate({ inputs: ['runtime.task', 'runtime.models'], taskId: task.data.id })
      }
      if (notification.method === runNotifications.event.method) {
        const event = runNotifications.event.params.safeParse(notification.params)
        if (event.success && /^(?:run\.(?:started|completed|failed|cancelled)|approval\.(?:requested|resolved))$/.test(event.data.type))
          extensions.conditions.invalidate({ inputs: ['runtime.task'] })
      }
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
    const updates = registerDesktopUpdates(this.#environment, runtime, windows)
    this.#subscriptions.push(updates.dispose)
    registerDesktopIpc({
      getSandboxStatus: () => this.#runtime.getSandboxStatus(),
      setupSandbox: () => this.#runtime.setupSandbox(),
      checkForUpdates: updates.check,
      configPath: paths.configPath,
      runtimeProfile: paths.profile,
      configStore: runtime.configStore,
      executeCommand: this.executeCommand,
      getWindow: () => windows.window,
      onConfigUpdated: config => this.applyConfig(config),
      openFeedbackIssue: feedback => shell.openExternal(createFeedbackIssueUrl(feedback)),
      openReleasePage: url => shell.openExternal(url),
    })
    const configNotifications = runtime.configStore.onDidChange((change) => {
      if (change.kind === 'committed' && windows.window && !windows.window.isDestroyed())
        windows.window.webContents.send(DESKTOP_IPC_CHANNELS.settingsChanged, change.config)
    })
    this.#subscriptions.push(() => configNotifications.dispose())
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
