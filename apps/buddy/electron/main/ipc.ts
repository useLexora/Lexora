import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { LexoraConfig } from '../shared/desktopApi'
import type { LexoraConfigStore } from './config/LexoraConfigStore'
import type { ExecuteDesktopCommand } from './desktopCommands'
import process from 'node:process'
import { app, clipboard, ipcMain } from 'electron'
import { currentPlatform } from '../../platform/currentPlatform'
import { sandboxEnvironmentStatusSchema, sandboxSetupResultSchema } from '../../shared/permissions/shellSandbox'
import { describeBuddyCapabilities } from '../../shared/platform'
import {
  DESKTOP_IPC_CHANNELS,
} from '../shared/desktopApi'
import {
  clipboardWriteTextInputSchema,
  feedbackIssueInputSchema,
  lexoraConfigPatchSchema,
  releasePageInputSchema,
} from '../shared/desktopApiSchemas'
import { getDesktopCommand, isDesktopCommandId } from '../shared/desktopCommands'
import { readDesktopWindowState } from './window'

export interface RegisterDesktopIpcOptions {
  checkForUpdates: () => Promise<unknown>
  getSandboxStatus: () => Promise<unknown>
  setupSandbox: () => Promise<unknown>
  configPath: string
  configStore: LexoraConfigStore
  getWindow: () => BrowserWindow | null
  onConfigUpdated: (config: LexoraConfig) => Promise<void> | void
  openFeedbackIssue: (feedback: string) => Promise<unknown>
  openReleasePage: (url: string) => Promise<unknown>
  executeCommand: ExecuteDesktopCommand
}

export function registerDesktopIpc(options: RegisterDesktopIpcOptions): void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appSetupSandbox, async (event) => {
    assertTrustedSender(event, options.getWindow())
    return sandboxSetupResultSchema.parse(await options.setupSandbox())
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appGetSandboxStatus, async (event) => {
    assertTrustedSender(event, options.getWindow())
    return sandboxEnvironmentStatusSchema.parse(await options.getSandboxStatus())
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appCheckForUpdates, (event) => {
    assertTrustedSender(event, options.getWindow())
    return options.checkForUpdates()
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.appGetInfo, (event) => {
    assertTrustedSender(event, options.getWindow())
    return {
      capabilities: describeBuddyCapabilities(currentPlatform),
      chromiumVersion: process.versions.chrome,
      configPath: options.configPath,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: currentPlatform.id,
      version: app.getVersion(),
    }
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.clipboardWriteText, (event, input: unknown) => {
    assertTrustedSender(event, options.getWindow())
    const { text } = clipboardWriteTextInputSchema.parse(input)
    clipboard.writeText(text)
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.commandExecute, async (event, commandId: unknown) => {
    assertTrustedSender(event, options.getWindow())
    if (!isDesktopCommandId(commandId) || getDesktopCommand(commandId).execution !== 'main')
      throw new Error('Unsupported Desktop command')
    await options.executeCommand(commandId)
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.appOpenFeedbackIssue, async (event, input: unknown) => {
    assertTrustedSender(event, options.getWindow())
    const { feedback } = feedbackIssueInputSchema.parse(input)
    await options.openFeedbackIssue(feedback)
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.appOpenReleasePage, async (event, input: unknown) => {
    assertTrustedSender(event, options.getWindow())
    const { url } = releasePageInputSchema.parse(input)
    await options.openReleasePage(url)
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.settingsGet, (event) => {
    assertTrustedSender(event, options.getWindow())
    return options.configStore.read()
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.settingsUpdate, async (event, input: unknown) => {
    assertTrustedSender(event, options.getWindow())
    return options.configStore.update(lexoraConfigPatchSchema.parse(input), options.onConfigUpdated)
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.windowGetState, (event) => {
    const window = requireTrustedWindow(event, options.getWindow())
    return readDesktopWindowState(window)
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.windowMinimize, (event) => {
    requireTrustedWindow(event, options.getWindow()).minimize()
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.windowToggleMaximize, (event) => {
    const window = requireTrustedWindow(event, options.getWindow())
    if (window.isMaximized())
      window.unmaximize()
    else
      window.maximize()

    return readDesktopWindowState(window)
  })
}

function requireTrustedWindow(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
): BrowserWindow {
  assertTrustedSender(event, window)
  return window as BrowserWindow
}

export function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): void {
  if (!window
    || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Untrusted Desktop IPC sender')
  }
}
