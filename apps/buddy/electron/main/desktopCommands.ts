import type { BrowserWindow } from 'electron'
import type { DesktopCommandId } from '../shared/desktopCommands'
import { mkdir } from 'node:fs/promises'
import { getDesktopCommand } from '../shared/desktopCommands'
import { DOCUMENTATION_URL } from '../shared/productLinks'

export interface DesktopCommandExecutorOptions {
  getWindow: () => BrowserWindow | null
  isDeveloperToolsEnabled: () => boolean
  logDirectory: string
  openExternal: (url: string) => Promise<unknown>
  openPath: (path: string) => Promise<string>
  requestQuit: () => void
}

export type ExecuteDesktopCommand = (commandId: DesktopCommandId) => Promise<void>

export function createDesktopCommandExecutor(
  options: DesktopCommandExecutorOptions,
): ExecuteDesktopCommand {
  const handlers = {
    'app.quit': async () => options.requestQuit(),
    'help.openDocumentation': async () => {
      await options.openExternal(DOCUMENTATION_URL)
    },
    'help.openLogsDirectory': async () => {
      await mkdir(options.logDirectory, { mode: 0o700, recursive: true })
      const errorMessage = await options.openPath(options.logDirectory)
      if (errorMessage)
        throw new Error(errorMessage)
    },
    'window.close': async () => {
      options.getWindow()?.close()
    },
    'window.toggleDeveloperTools': async () => {
      const webContents = options.getWindow()?.webContents
      if (!webContents)
        return
      if (!options.isDeveloperToolsEnabled()) {
        if (webContents.isDevToolsOpened())
          webContents.closeDevTools()
        return
      }
      webContents.toggleDevTools()
    },
  } satisfies Partial<Record<DesktopCommandId, () => Promise<void>>>

  return async (commandId) => {
    const command = getDesktopCommand(commandId)
    if (command.execution !== 'main')
      throw new Error(`Desktop command must execute in renderer: ${commandId}`)
    const handler = handlers[commandId as keyof typeof handlers]
    if (!handler)
      throw new Error(`Desktop command has no main handler: ${commandId}`)
    await handler()
  }
}
