import type { ContextPanelCommand, ContextPanelState } from '../../shared/context-panel/contextPanel'
import type { ApplicationDiagnostic } from '../../shared/diagnostics/applicationDiagnostic'
import type { ApplicationLogQuery } from '../../shared/diagnostics/applicationLog'
import type { ApplicationStartupState } from '../../shared/diagnostics/applicationStartup'
import type { DesktopAppInfo, DesktopOpenTarget, DesktopWindowState, LexoraConfigPatch, LexoraDesktopApi } from '../shared/desktopApi'
import type { DesktopCommandId } from '../shared/desktopCommands'
import { ipcRenderer, webUtils } from 'electron'
import { DESKTOP_IPC_CHANNELS } from '../shared/desktopApi'
import { subscribe } from './subscribe'

export function createDesktopApi(): Pick<LexoraDesktopApi, 'app' | 'clipboard' | 'commands' | 'contextPanel' | 'settings' | 'window'> {
  return {
    contextPanel: Object.freeze({
      getState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.contextPanelGetState),
      execute: (command: ContextPanelCommand) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.contextPanelExecute, {
        action: command.action,
        source: command.source ? { ...command.source } : null,
        ...(command.action === 'open' ? { target: command.target ? { kind: command.target.kind, source: { ...command.target.source } } : null } : {}),
      }),
      onStateChanged: (listener: (state: ContextPanelState) => void) => subscribe(DESKTOP_IPC_CHANNELS.contextPanelStateChanged, listener),
    }),
    app: Object.freeze({
      logs: Object.freeze({
        query: (input: ApplicationLogQuery) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appLogsQuery, {
          ...input,
          anchor: input.anchor ? { launchId: input.anchor.launchId, sequence: input.anchor.sequence } : undefined,
        }),
      }),
      startup: Object.freeze({
        getState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appStartupGetState),
        onStateChanged: (listener: (state: ApplicationStartupState) => void) => subscribe(DESKTOP_IPC_CHANNELS.appStartupStateChanged, listener),
        reportEvent: (event: ApplicationDiagnostic) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appStartupReport, { ...event }),
      }),
      checkForUpdates: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appCheckForUpdates),
      getInfo: (): Promise<DesktopAppInfo> => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appGetInfo),
      getSandboxStatus: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appGetSandboxStatus),
      setupSandbox: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appSetupSandbox),
      onBeforeQuit: (listener: () => Promise<boolean>) => {
        const handler = (_event: Electron.IpcRendererEvent, input: { requestId?: unknown }) => {
          const requestId = typeof input?.requestId === 'string' ? input.requestId : ''
          if (!requestId)
            return
          void Promise.resolve()
            .then(() => listener())
            .catch(() => false)
            .then((saved) => {
              ipcRenderer.send(DESKTOP_IPC_CHANNELS.appPrepareQuitAck, { requestId, saved })
            })
        }
        ipcRenderer.on(DESKTOP_IPC_CHANNELS.appPrepareQuit, handler)
        return () => ipcRenderer.off(DESKTOP_IPC_CHANNELS.appPrepareQuit, handler)
      },
      onOpenTarget: (listener: (target: DesktopOpenTarget) => void) => (
        subscribe(DESKTOP_IPC_CHANNELS.appOpenTarget, listener)
      ),
      onHidden: (listener: () => void) => subscribe(DESKTOP_IPC_CHANNELS.appHidden, listener),
      openFeedbackIssue: (feedback: string) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.appOpenFeedbackIssue,
        { feedback },
      ),
      openReleasePage: (url: string) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.appOpenReleasePage,
        { url },
      ),
    }),
    clipboard: Object.freeze({
      getFilePath: (file: File) => webUtils.getPathForFile(file),
      writeText: (text: string) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.clipboardWriteText,
        { text },
      ),
    }),
    commands: Object.freeze({
      execute: (commandId: DesktopCommandId) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.commandExecute, commandId),
    }),
    settings: Object.freeze({
      get: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.settingsGet),
      update: (patch: LexoraConfigPatch) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.settingsUpdate, patch),
    }),
    window: Object.freeze({
      getState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowGetState),
      minimize: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowMinimize),
      onStateChanged: (listener: (state: DesktopWindowState) => void) =>
        subscribe(DESKTOP_IPC_CHANNELS.windowStateChanged, listener),
      toggleMaximize: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.windowToggleMaximize),
    }),
  }
}
