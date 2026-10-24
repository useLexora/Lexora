import type { ContextPanelCommand, ContextPanelState } from '../../shared/context-panel/contextPanel'
import type { ApplicationLogExport, ApplicationLogQuery } from '../../shared/diagnostics/applicationLog'
import type { ApplicationStartupState } from '../../shared/diagnostics/applicationStartup'
import type { CpuProfileRequest } from '../../shared/diagnostics/performanceDiagnostic'
import type { RendererDiagnosticReport } from '../../shared/diagnostics/rendererDiagnostic'
import type { RendererLifecycleReport } from '../../shared/lifecycle/serviceLifecycle'
import type { BackupOptions } from '../../shared/storage/backupScope'
import type { StorageProgress } from '../../shared/storage/storageApi'
import type { BackupConfiguration, SyncConnectionInput, SyncState } from '../../shared/sync/syncApi'
import type { DesktopAppInfo, DesktopOpenTarget, DesktopWindowState, LexoraConfigPatch, LexoraDesktopApi } from '../shared/desktopApi'
import type { DesktopCommandId } from '../shared/desktopCommands'
import type { DesktopUpdateAction, DesktopUpdateState } from '../shared/desktopUpdates'
import { ipcRenderer, webUtils } from 'electron'
import { STORAGE_CHANGED, STORAGE_CHANNEL } from '../../shared/storage/storageApi'
import { SYNC_CHANGED, SYNC_CHANNEL } from '../../shared/sync/syncApi'
import { DESKTOP_IPC_CHANNELS } from '../shared/desktopApi'
import { subscribe } from './subscribe'

export function createDesktopApi(): Pick<LexoraDesktopApi, 'app' | 'clipboard' | 'commands' | 'contextPanel' | 'settings' | 'storage' | 'sync' | 'window' | 'workbench'> {
  return {
    sync: Object.freeze({
      selectAdapter: (adapter: 'webdav' | 's3') => ipcRenderer.invoke(SYNC_CHANNEL, { action: 'selectAdapter', adapter }),
      setFrequency: (frequency: 'hourly' | 'daily' | 'weekly') => ipcRenderer.invoke(SYNC_CHANNEL, { action: 'frequency', frequency }),
      backupNow: (options: BackupOptions, configuration?: BackupConfiguration) => ipcRenderer.invoke(SYNC_CHANNEL, { action: 'backupNow', options: { ...options, scopes: [...options.scopes] }, ...(configuration ? { configuration: { frequency: configuration.frequency, connection: { ...configuration.connection } } } : {}) }),
      testConnection: (connection: SyncConnectionInput) => ipcRenderer.invoke(SYNC_CHANNEL, { action: 'testConnection', connection: { ...connection } }),
      credential: (id: string) => ipcRenderer.invoke(SYNC_CHANNEL, { action: 'credential', id }),
      state: () => ipcRenderer.invoke(SYNC_CHANNEL, { action: 'state' }),
      setEnabled: (enabled: boolean) => ipcRenderer.invoke(SYNC_CHANNEL, { action: 'setEnabled', enabled }),
      onChanged: (listener: (state: SyncState) => void) => subscribe(SYNC_CHANGED, listener),
    }),
    storage: Object.freeze({
      prune: () => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'prune' }),
      delete: (id: string) => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'delete', id }),
      snapshots: () => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'snapshots' }),
      snapshot: (options?: BackupOptions) => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'snapshot', options }),
      restore: (id: string, options: BackupOptions) => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'restore', id, options }),
      import: () => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'import' }),
      export: (id: string) => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'export', id }),
      onProgress: (listener: (progress: StorageProgress | null) => void) => subscribe(STORAGE_CHANGED, listener),
      summary: () => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'summary' }),
      usage: () => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'usage' }),
      choose: () => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'choose' }),
      open: () => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'open' }),
      relocate: (target: string) => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'relocate', target }),
      cancel: () => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'cancel' }),
      restart: () => ipcRenderer.invoke(STORAGE_CHANNEL, { action: 'restart' }),
    }),
    workbench: Object.freeze({
      read: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.workbenchRead),
      write: (state: import('../../shared/workbench/workbenchState').WorkbenchState, options?: import('../../shared/workbench/workbenchState').WorkbenchWriteOptions) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.workbenchWrite, state, options),
    }),
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
      performance: Object.freeze({
        snapshot: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appPerformanceSnapshot),
        capture: (request: CpuProfileRequest) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appPerformanceCapture, { target: request.target, pid: request.pid }),
      }),
      logs: Object.freeze({
        report: (input: RendererDiagnosticReport) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appLogsReport, input),
        exportDiagnostics: (input: ApplicationLogExport) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appLogsExportDiagnostics, { launch: input.launch, anchor: input.anchor ? { ...input.anchor } : undefined }),
        query: (input: ApplicationLogQuery) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appLogsQuery, {
          ...input,
          anchor: input.anchor ? { launchId: input.anchor.launchId, sequence: input.anchor.sequence } : undefined,
        }),
      }),
      startup: Object.freeze({
        getState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appStartupGetState),
        onStateChanged: (listener: (state: ApplicationStartupState) => void) => subscribe(DESKTOP_IPC_CHANNELS.appStartupStateChanged, listener),
        reportLifecycle: (report: RendererLifecycleReport) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appStartupReport, report),
      }),
      updates: Object.freeze({
        download: (version: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appUpdatesDownload, { version }),
        cancelDownload: (version: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appUpdatesCancelDownload, { version }),
        install: (version: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appUpdatesInstall, { version }),
        openPackage: (version: string) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appUpdatesOpenPackage, { version }),
        openDownloadDirectory: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appUpdatesOpenDirectory),
        getCacheSummary: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appUpdatesCacheSummary),
        clearCache: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appUpdatesClearCache),
        getState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appUpdatesState),
        onChanged: (listener: (state: DesktopUpdateState) => void) => subscribe(DESKTOP_IPC_CHANNELS.appUpdatesChanged, listener),
        acknowledge: (input: DesktopUpdateAction) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appUpdatesAcknowledge, { version: input.version, action: input.action, ...(input.action === 'snooze' ? { delay: input.delay } : {}) }),
        takeReminder: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appUpdatesTakeReminder),
      }),
      checkForUpdates: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appCheckForUpdates),
      getInfo: (): Promise<DesktopAppInfo> => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appGetInfo),
      getSandboxStatus: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appGetSandboxStatus),
      setupSandbox: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appSetupSandbox),
      onQuitPreparationCancelled: (listener: (requestId: string) => void) => subscribe(DESKTOP_IPC_CHANNELS.appCancelQuitPreparation, (input: { requestId: string }) => listener(input.requestId)),
      onBeforeQuit: (listener: (requestId: string) => Promise<boolean>) => {
        const handler = (_event: Electron.IpcRendererEvent, input: { requestId?: unknown }) => {
          const requestId = typeof input?.requestId === 'string' ? input.requestId : ''
          if (!requestId)
            return
          void Promise.resolve()
            .then(() => listener(requestId))
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
      writeText: (text: string, html?: string) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.clipboardWriteText,
        { text, ...(html === undefined ? {} : { html }) },
      ),
    }),
    commands: Object.freeze({
      execute: (commandId: DesktopCommandId) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.commandExecute, commandId),
    }),
    settings: Object.freeze({
      onChanged: listener => subscribe(DESKTOP_IPC_CHANNELS.settingsChanged, listener),
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
