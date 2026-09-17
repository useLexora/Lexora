import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { BrowserDataService } from './BrowserDataService'
import type { BrowserHost } from './BrowserHost'
import type { BrowserScreenshotService } from './BrowserScreenshotService'
import { fileURLToPath } from 'node:url'
import { ipcMain, session, shell, webContents } from 'electron'
import { browserClearDataInputSchema, browserClearDataResultSchema, browserDataSummarySchema } from '../../../shared/browser/browserData'
import {
  browserAttachGuestInputSchema,
  browserEnsureSessionInputSchema,
  browserNavigateInputSchema,
  browserOpenArtifactInputSchema,
  browserSessionInputSchema,
  browserSetProfileModeInputSchema,
  browserSetSurfaceInputSchema,
  browserSetZoomFactorInputSchema,
  desktopBrowserGuestDescriptorsSchema,
  desktopBrowserStateSchema,
} from '../../../shared/browser/browserDesktopSchemas'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { assertTrustedSender } from '../ipc'

export interface RegisterBrowserDesktopIpcOptions {
  data: Pick<BrowserDataService, 'clear' | 'getSummary'>
  screenshots: Pick<BrowserScreenshotService, 'capture'>
  getHost: () => BrowserHost | null
  getWindow: () => BrowserWindow | null
  resolveArtifactEntry: (input: {
    artifactId: string
    conversationId: string
  }) => Promise<{ entryPath: string, rootPath: string }>
}

export function registerBrowserDesktopIpc(
  options: RegisterBrowserDesktopIpcOptions,
): () => void {
  const registeredChannels: string[] = []
  const handle = (
    channel: string,
    handler: (host: BrowserHost, input: unknown, event: IpcMainInvokeEvent) => unknown,
  ) => {
    registeredChannels.push(channel)
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, input: unknown) => {
      assertTrustedSender(event, options.getWindow())
      const host = requireBrowserHost(options.getHost())
      return handler(host, input, event)
    })
  }

  handle(DESKTOP_IPC_CHANNELS.browserAttachGuest, (host, input, event) => {
    const { sessionId, webContentsId } = browserAttachGuestInputSchema.parse(input)
    const guest = webContents.fromId(webContentsId)
    if (
      !guest
      || guest.getType() !== 'webview'
      || guest.hostWebContents !== event.sender
    ) {
      throw new Error('Browser guest does not belong to the Desktop renderer')
    }
    const descriptor = host.getGuestDescriptor(sessionId)
    if (guest.session !== session.fromPartition(descriptor.partition))
      throw new Error('Browser guest does not belong to the requested session')
    host.attachGuest(sessionId, guest)
  })
  handle(DESKTOP_IPC_CHANNELS.browserCaptureScreenshot, async (host, input) => {
    const { sessionId } = browserSessionInputSchema.parse(input)
    const window = options.getWindow()
    if (!window)
      throw new Error('Browser window is unavailable')
    return options.screenshots.capture(window, () => host.captureScreenshot(sessionId))
  })
  handle(DESKTOP_IPC_CHANNELS.browserGetDataSummary, async () => browserDataSummarySchema.parse(await options.data.getSummary()))
  handle(DESKTOP_IPC_CHANNELS.browserClearData, async (_host, input) => (
    browserClearDataResultSchema.parse(await options.data.clear(browserClearDataInputSchema.parse(input)))
  ))
  handle(DESKTOP_IPC_CHANNELS.browserSetZoomFactor, async (host, input) => {
    const { sessionId, zoomFactor } = browserSetZoomFactorInputSchema.parse(input)
    takeHumanControl(host, sessionId)
    return desktopBrowserStateSchema.parse(await host.setZoomFactor(sessionId, zoomFactor))
  })
  handle(DESKTOP_IPC_CHANNELS.browserEnsureSession, (host, input) => {
    const { conversationId, tabId } = browserEnsureSessionInputSchema.parse(input)
    return desktopBrowserStateSchema.parse(host.ensureSession(conversationId, tabId))
  })
  handle(DESKTOP_IPC_CHANNELS.browserGoBack, (host, input) => {
    const { sessionId } = browserSessionInputSchema.parse(input)
    takeHumanControl(host, sessionId)
    host.goBack(sessionId)
  })
  handle(DESKTOP_IPC_CHANNELS.browserGoForward, (host, input) => {
    const { sessionId } = browserSessionInputSchema.parse(input)
    takeHumanControl(host, sessionId)
    host.goForward(sessionId)
  })
  handle(DESKTOP_IPC_CHANNELS.browserListGuests, host => (
    desktopBrowserGuestDescriptorsSchema.parse(host.listGuests())
  ))
  handle(DESKTOP_IPC_CHANNELS.browserNavigate, async (host, input) => {
    const { sessionId, url } = browserNavigateInputSchema.parse(input)
    takeHumanControl(host, sessionId)
    return desktopBrowserStateSchema.parse(await host.navigate(sessionId, url))
  })
  handle(DESKTOP_IPC_CHANNELS.browserOpenArtifact, async (host, input) => {
    const { artifactId, sessionId } = browserOpenArtifactInputSchema.parse(input)
    const conversationId = host.getState(sessionId).conversationId
    if (!conversationId)
      throw new Error('Artifact previews require a conversation browser session')
    const entry = await options.resolveArtifactEntry({ artifactId, conversationId })
    takeHumanControl(host, sessionId)
    return desktopBrowserStateSchema.parse(await host.openLocalFile(sessionId, entry))
  })
  handle(DESKTOP_IPC_CHANNELS.browserOpenExternal, async (host, input) => {
    const { sessionId } = browserSessionInputSchema.parse(input)
    const { url } = host.getState(sessionId)
    if (url === 'about:blank')
      return false
    if (url.startsWith('file:')) {
      const error = await shell.openPath(fileURLToPath(url))
      if (error)
        throw new Error(error)
      return true
    }
    await shell.openExternal(url)
    return true
  })
  handle(DESKTOP_IPC_CHANNELS.browserReload, (host, input) => {
    const { sessionId } = browserSessionInputSchema.parse(input)
    takeHumanControl(host, sessionId)
    host.reload(sessionId)
  })
  handle(DESKTOP_IPC_CHANNELS.browserSetProfileMode, async (host, input) => {
    const { profileMode, sessionId } = browserSetProfileModeInputSchema.parse(input)
    takeHumanControl(host, sessionId)
    return desktopBrowserStateSchema.parse(await host.setProfileMode(sessionId, profileMode))
  })
  handle(DESKTOP_IPC_CHANNELS.browserSetSurface, (host, input) => {
    host.setSurface(browserSetSurfaceInputSchema.parse(input))
  })
  handle(DESKTOP_IPC_CHANNELS.browserStop, (host, input) => {
    const { sessionId } = browserSessionInputSchema.parse(input)
    takeHumanControl(host, sessionId)
    host.stop(sessionId)
  })
  handle(DESKTOP_IPC_CHANNELS.browserShowFileInFolder, (host, input) => {
    const { sessionId } = browserSessionInputSchema.parse(input)
    const { url } = host.getState(sessionId)
    if (!url.startsWith('file:'))
      return false
    shell.showItemInFolder(fileURLToPath(url))
    return true
  })
  handle(DESKTOP_IPC_CHANNELS.browserTakeControl, (host, input) => {
    const { sessionId } = browserSessionInputSchema.parse(input)
    return desktopBrowserStateSchema.parse(host.takeControl(sessionId))
  })
  handle(DESKTOP_IPC_CHANNELS.browserClose, (host, input) => {
    const { sessionId } = browserSessionInputSchema.parse(input)
    host.close(sessionId)
  })

  return () => {
    for (const channel of registeredChannels)
      ipcMain.removeHandler(channel)
  }
}

function requireBrowserHost(host: BrowserHost | null): BrowserHost {
  if (!host)
    throw new Error('Browser host is unavailable')
  return host
}

function takeHumanControl(host: BrowserHost, sessionId: string): void {
  if (host.getState(sessionId).controller === 'agent')
    host.takeControl(sessionId)
}
