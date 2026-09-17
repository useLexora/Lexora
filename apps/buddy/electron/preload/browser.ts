import type { BrowserClearDataInput } from '../../shared/browser/browserData'
import type { BrowserScreenshotResult } from '../../shared/browser/browserDesktopApi'
import type { DesktopBrowserGuestDescriptor, DesktopBrowserProfileMode, DesktopBrowserSetSurfaceInput, DesktopBrowserState, LexoraDesktopApi } from '../shared/desktopApi'
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC_CHANNELS } from '../shared/desktopApi'
import { subscribe } from './subscribe'

export function createBrowserApi(): Pick<LexoraDesktopApi, 'browser'> {
  return {
    browser: Object.freeze({
      attachGuest: (sessionId: string, webContentsId: number) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserAttachGuest,
        { sessionId, webContentsId },
      ),
      captureScreenshot: (sessionId: string): Promise<BrowserScreenshotResult> => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserCaptureScreenshot,
        { sessionId },
      ),
      clearData: (input: BrowserClearDataInput) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserClearData,
        { cache: input.cache, siteData: input.siteData },
      ),
      getDataSummary: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.browserGetDataSummary),
      setZoomFactor: (sessionId: string, zoomFactor: number | null) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserSetZoomFactor,
        { sessionId, zoomFactor },
      ),
      close: (sessionId: string) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserClose,
        { sessionId },
      ),
      ensureSession: (conversationId: string | null, tabId?: string): Promise<DesktopBrowserState> => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserEnsureSession,
        { conversationId, ...(tabId ? { tabId } : {}) },
      ),
      goBack: (sessionId: string) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserGoBack,
        { sessionId },
      ),
      goForward: (sessionId: string) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserGoForward,
        { sessionId },
      ),
      listGuests: (): Promise<DesktopBrowserGuestDescriptor[]> => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserListGuests,
      ),
      navigate: (sessionId: string, url: string): Promise<DesktopBrowserState> => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserNavigate,
        { sessionId, url },
      ),
      onStateChanged: (listener: (state: DesktopBrowserState) => void) =>
        subscribe(DESKTOP_IPC_CHANNELS.browserStateChanged, listener),
      onGuestsChanged: (listener: () => void) => subscribe<void>(
        DESKTOP_IPC_CHANNELS.browserGuestsChanged,
        listener,
      ),
      openArtifact: (
        sessionId: string,
        artifactId: string,
      ): Promise<DesktopBrowserState> => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserOpenArtifact,
        { artifactId, sessionId },
      ),
      openExternal: (sessionId: string): Promise<boolean> => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserOpenExternal,
        { sessionId },
      ),
      reload: (sessionId: string) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserReload,
        { sessionId },
      ),
      setProfileMode: (
        sessionId: string,
        profileMode: DesktopBrowserProfileMode,
      ): Promise<DesktopBrowserState> => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserSetProfileMode,
        { profileMode, sessionId },
      ),
      setSurface: (input: DesktopBrowserSetSurfaceInput) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserSetSurface,
        { sessionId: input.sessionId, visible: input.visible },
      ),
      stop: (sessionId: string) => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserStop,
        { sessionId },
      ),
      showFileInFolder: (sessionId: string): Promise<boolean> => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserShowFileInFolder,
        { sessionId },
      ),
      takeControl: (sessionId: string): Promise<DesktopBrowserState> => ipcRenderer.invoke(
        DESKTOP_IPC_CHANNELS.browserTakeControl,
        { sessionId },
      ),
    }),
  }
}
