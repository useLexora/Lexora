import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { BrowserHost } from '../BrowserHost'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BROWSER_PREFERENCES } from '../../../../shared/browser/browserPreferences'
import { DESKTOP_IPC_CHANNELS } from '../../../shared/desktopApi'
import { BrowserScreenshotService } from '../BrowserScreenshotService'
import { registerBrowserDesktopIpc } from '../registerBrowserDesktopIpc'

const electron = vi.hoisted(() => ({
  fromId: vi.fn(),
  fromPartition: vi.fn(),
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>(),
  openExternal: vi.fn(),
  openPath: vi.fn(),
  removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
  showOpenDialog: vi.fn(),
  showItemInFolder: vi.fn(),
  showSaveDialog: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ writeFile: electron.writeFile }))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0' },
  clipboard: { writeText: vi.fn() },
  dialog: {
    showOpenDialog: electron.showOpenDialog,
    showSaveDialog: electron.showSaveDialog,
  },
  ipcMain: {
    handle: vi.fn((channel, handler) => electron.handlers.set(channel, handler)),
    removeHandler: electron.removeHandler,
  },
  session: { fromPartition: electron.fromPartition },
  shell: {
    openExternal: electron.openExternal,
    openPath: electron.openPath,
    showItemInFolder: electron.showItemInFolder,
  },
  webContents: { fromId: electron.fromId },
}))

beforeEach(() => {
  electron.handlers.clear()
  electron.showOpenDialog.mockReset()
  electron.showSaveDialog.mockReset()
  electron.fromId.mockReset()
  electron.fromPartition.mockReset()
  electron.openExternal.mockReset()
  electron.openPath.mockReset()
  electron.showItemInFolder.mockReset()
  electron.writeFile.mockReset()
})

describe('registerBrowserDesktopIpc', () => {
  it('validates trusted Renderer requests before forwarding them to BrowserHost', async () => {
    const sessionId = 'd86be868-6a84-45da-90aa-ff61f3c88f85'
    const state = {
      zoomFactor: 1,
      canGoBack: false,
      canGoForward: false,
      controller: 'human',
      controlEpoch: 0,
      conversationId: 'conversation-1',
      error: null,
      pageId: '0329d6c4-9b70-480d-863f-b3ef79054e3f',
      profileMode: 'default',
      security: { kind: 'blank', origin: null },
      sessionId,
      status: 'idle',
      title: '',
      url: 'about:blank',
      visible: false,
    } as const
    const getState = vi.fn().mockReturnValue(state)
    const host = {
      close: vi.fn(),
      captureScreenshot: vi.fn().mockResolvedValue({
        bytes: Uint8Array.from([137, 80, 78, 71]),
        title: 'Example',
      }),
      setProfileMode: vi.fn().mockResolvedValue({
        ...state,
        profileMode: 'incognito',
      }),
      ensureSession: vi.fn().mockReturnValue(state),
      goBack: vi.fn(),
      goForward: vi.fn(),
      getState,
      navigate: vi.fn().mockResolvedValue({ ...state, url: 'https://example.com/' }),
      reload: vi.fn(),
      setSurface: vi.fn(),
      stop: vi.fn(),
      takeControl: vi.fn().mockReturnValue({
        ...state,
        controller: 'human',
        controlEpoch: 2,
      }),
    } as unknown as BrowserHost
    const webContents = { mainFrame: {} }
    const window = { webContents } as unknown as BrowserWindow
    registerBrowserDesktopIpc({
      data: { getSummary: async () => ({ cacheBytes: 0, cookieSiteCount: 0 }), clear: async () => ({ ok: true }) },
      screenshots: new BrowserScreenshotService(() => DEFAULT_BROWSER_PREFERENCES),
      getHost: () => host,
      getWindow: () => window,
      resolveArtifactEntry: async () => { throw new Error('unused') },
    })
    const trustedEvent = {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent
    const untrustedEvent = {
      sender: {},
      senderFrame: {},
    } as unknown as IpcMainInvokeEvent

    await expect(invoke(DESKTOP_IPC_CHANNELS.browserEnsureSession, trustedEvent, {
      conversationId: 'conversation-1',
    })).resolves.toEqual(state)
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserSetProfileMode, trustedEvent, {
      profileMode: 'incognito',
      sessionId,
    })).resolves.toMatchObject({ profileMode: 'incognito' })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserNavigate, trustedEvent, {
      sessionId,
      url: 'https://example.com',
    })).resolves.toMatchObject({ url: 'https://example.com/' })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserGoBack, trustedEvent, {
      sessionId,
    })).resolves.toBeUndefined()
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserGoForward, trustedEvent, {
      sessionId,
    })).resolves.toBeUndefined()
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserReload, trustedEvent, {
      sessionId,
    })).resolves.toBeUndefined()
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserStop, trustedEvent, {
      sessionId,
    })).resolves.toBeUndefined()
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserTakeControl, trustedEvent, {
      sessionId,
    })).resolves.toMatchObject({ controller: 'human', controlEpoch: 2 })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserSetSurface, trustedEvent, {
      sessionId,
      visible: true,
    })).resolves.toBeUndefined()
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserClose, trustedEvent, {
      sessionId,
    })).resolves.toBeUndefined()

    expect(host.ensureSession).toHaveBeenCalledExactlyOnceWith('conversation-1', undefined)
    expect(host.setProfileMode).toHaveBeenCalledExactlyOnceWith(sessionId, 'incognito')
    expect(host.goBack).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(host.goForward).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(host.navigate).toHaveBeenCalledExactlyOnceWith(sessionId, 'https://example.com')
    expect(host.reload).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(host.setSurface).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      visible: true,
    })
    expect(host.close).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(host.stop).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(host.takeControl).toHaveBeenCalledExactlyOnceWith(sessionId)

    await expect(invoke(DESKTOP_IPC_CHANNELS.browserNavigate, trustedEvent, {
      sessionId,
      url: 'javascript:alert(1)',
    })).rejects.toThrow()
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserClose, untrustedEvent, {
      sessionId,
    })).rejects.toThrow('Untrusted Desktop IPC sender')
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserReload, trustedEvent, {
      extra: true,
      sessionId,
    })).rejects.toThrow()
    expect(host.navigate).toHaveBeenCalledOnce()
    expect(host.close).toHaveBeenCalledOnce()
    expect(host.reload).toHaveBeenCalledOnce()
  })

  it('binds only a webview guest owned by the trusted Desktop renderer', async () => {
    const sessionId = 'd86be868-6a84-45da-90aa-ff61f3c88f85'
    const attachGuest = vi.fn()
    const partition = `buddy-browser:${sessionId}`
    const expectedSession = {}
    const getGuestDescriptor = vi.fn().mockReturnValue({ partition, sessionId })
    const listGuests = vi.fn().mockReturnValue([{
      partition,
      sessionId,
    }])
    const host = { attachGuest, getGuestDescriptor, listGuests } as unknown as BrowserHost
    const hostWebContents = { mainFrame: {} }
    const guest = {
      getType: () => 'webview',
      hostWebContents,
      session: expectedSession,
    }
    electron.fromId.mockReturnValue(guest)
    electron.fromPartition.mockReturnValue(expectedSession)
    registerBrowserDesktopIpc({
      data: { getSummary: async () => ({ cacheBytes: 0, cookieSiteCount: 0 }), clear: async () => ({ ok: true }) },
      screenshots: new BrowserScreenshotService(() => DEFAULT_BROWSER_PREFERENCES),
      getHost: () => host,
      getWindow: () => ({ webContents: hostWebContents }) as unknown as BrowserWindow,
      resolveArtifactEntry: async () => { throw new Error('unused') },
    })
    const trustedEvent = {
      sender: hostWebContents,
      senderFrame: hostWebContents.mainFrame,
    } as unknown as IpcMainInvokeEvent

    await expect(invoke(DESKTOP_IPC_CHANNELS.browserListGuests, trustedEvent, undefined))
      .resolves
      .toEqual([{ partition, sessionId }])
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserAttachGuest, trustedEvent, {
      sessionId,
      webContentsId: 42,
    })).resolves.toBeUndefined()
    expect(electron.fromId).toHaveBeenCalledExactlyOnceWith(42)
    expect(electron.fromPartition).toHaveBeenCalledExactlyOnceWith(partition)
    expect(getGuestDescriptor).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(attachGuest).toHaveBeenCalledExactlyOnceWith(sessionId, guest)

    electron.fromId.mockReturnValueOnce({
      getType: () => 'webview',
      hostWebContents: { mainFrame: {} },
      session: expectedSession,
    })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserAttachGuest, trustedEvent, {
      sessionId,
      webContentsId: 43,
    })).rejects.toThrow('Browser guest does not belong to the Desktop renderer')
    expect(attachGuest).toHaveBeenCalledOnce()

    electron.fromId.mockReturnValueOnce({
      getType: () => 'webview',
      hostWebContents,
      session: {},
    })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserAttachGuest, trustedEvent, {
      sessionId,
      webContentsId: 44,
    })).rejects.toThrow('Browser guest does not belong to the requested session')
    expect(attachGuest).toHaveBeenCalledOnce()
  })

  it('takes human control before a Renderer navigation command', async () => {
    const sessionId = 'd86be868-6a84-45da-90aa-ff61f3c88f85'
    const state = {
      canGoBack: true,
      canGoForward: false,
      controller: 'agent',
      controlEpoch: 5,
      conversationId: 'conversation-1',
      error: null,
      pageId: '0329d6c4-9b70-480d-863f-b3ef79054e3f',
      profileMode: 'default',
      security: { kind: 'secure', origin: 'https://example.com' },
      sessionId,
      status: 'ready',
      title: 'Example',
      url: 'https://example.com/',
      visible: true,
    } as const
    const getState = vi.fn().mockReturnValue(state)
    const goBack = vi.fn()
    const takeControl = vi.fn().mockReturnValue({
      ...state,
      controller: 'human',
      controlEpoch: 6,
    })
    const host = {
      getState,
      goBack,
      takeControl,
    } as unknown as BrowserHost
    const webContents = { mainFrame: {} }
    const window = { webContents } as unknown as BrowserWindow
    registerBrowserDesktopIpc({
      data: { getSummary: async () => ({ cacheBytes: 0, cookieSiteCount: 0 }), clear: async () => ({ ok: true }) },
      screenshots: new BrowserScreenshotService(() => DEFAULT_BROWSER_PREFERENCES),
      getHost: () => host,
      getWindow: () => window,
      resolveArtifactEntry: async () => { throw new Error('unused') },
    })
    const trustedEvent = {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent

    await expect(invoke(DESKTOP_IPC_CHANNELS.browserGoBack, trustedEvent, {
      sessionId,
    })).resolves.toBeUndefined()

    expect(getState).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(takeControl).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(goBack).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(takeControl.mock.invocationCallOrder[0])
      .toBeLessThan(goBack.mock.invocationCallOrder[0]!)
  })

  it('opens the current page externally, saves a PNG, and reveals local files', async () => {
    const sessionId = 'd86be868-6a84-45da-90aa-ff61f3c88f85'
    const state = {
      zoomFactor: 1,
      canGoBack: false,
      canGoForward: false,
      controller: 'human',
      controlEpoch: 0,
      conversationId: 'conversation-1',
      error: null,
      pageId: '0329d6c4-9b70-480d-863f-b3ef79054e3f',
      profileMode: 'default',
      security: { kind: 'local', origin: 'file://' },
      sessionId,
      status: 'ready',
      title: 'Example: page?',
      url: 'file:///picked/space/site/index.html',
      visible: true,
    } as const
    const getState = vi.fn().mockReturnValue(state)
    const host = {
      captureScreenshot: vi.fn().mockResolvedValue({
        bytes: Uint8Array.from([137, 80, 78, 71]),
        title: state.title,
      }),
      getState,
    } as unknown as BrowserHost
    const webContents = { mainFrame: {} }
    const window = { webContents } as unknown as BrowserWindow
    electron.openPath.mockResolvedValue('')
    electron.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/saved/Example page.png',
    })
    registerBrowserDesktopIpc({
      data: { getSummary: async () => ({ cacheBytes: 0, cookieSiteCount: 0 }), clear: async () => ({ ok: true }) },
      screenshots: new BrowserScreenshotService(() => DEFAULT_BROWSER_PREFERENCES),
      getHost: () => host,
      getWindow: () => window,
      resolveArtifactEntry: async () => { throw new Error('unused') },
    })
    const trustedEvent = {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent

    await expect(invoke(DESKTOP_IPC_CHANNELS.browserOpenExternal, trustedEvent, {
      sessionId,
    })).resolves.toBe(true)
    expect(electron.openPath).toHaveBeenCalledExactlyOnceWith(
      '/picked/space/site/index.html',
    )

    await expect(invoke(DESKTOP_IPC_CHANNELS.browserCaptureScreenshot, trustedEvent, {
      sessionId,
    })).resolves.toBe('saved')
    expect(electron.showSaveDialog).toHaveBeenCalledExactlyOnceWith(window, {
      defaultPath: 'Example page.png',
      filters: [{ extensions: ['png'], name: 'PNG image' }],
    })
    expect(electron.writeFile).toHaveBeenCalledExactlyOnceWith(
      '/saved/Example page.png',
      Uint8Array.from([137, 80, 78, 71]),
    )

    await expect(invoke(DESKTOP_IPC_CHANNELS.browserShowFileInFolder, trustedEvent, {
      sessionId,
    })).resolves.toBe(true)
    expect(electron.showItemInFolder).toHaveBeenCalledExactlyOnceWith(
      '/picked/space/site/index.html',
    )

    getState.mockReturnValue({
      ...state,
      security: { kind: 'secure', origin: 'https://example.com' },
      url: 'https://example.com/',
    })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserOpenExternal, trustedEvent, {
      sessionId,
    })).resolves.toBe(true)
    expect(electron.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/')
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserShowFileInFolder, trustedEvent, {
      sessionId,
    })).resolves.toBe(false)
    expect(electron.showItemInFolder).toHaveBeenCalledOnce()
  })

  it('resolves an HTML artifact with its local resource root', async () => {
    const sessionId = 'd86be868-6a84-45da-90aa-ff61f3c88f85'
    const state = {
      zoomFactor: 1,
      canGoBack: false,
      canGoForward: false,
      controller: 'human',
      controlEpoch: 0,
      conversationId: 'conversation-1',
      error: null,
      pageId: '0329d6c4-9b70-480d-863f-b3ef79054e3f',
      profileMode: 'default',
      security: { kind: 'blank', origin: null },
      sessionId,
      status: 'idle',
      title: '',
      url: 'about:blank',
      visible: false,
    } as const
    const host = {
      getState: vi.fn().mockReturnValue(state),
      openLocalFile: vi.fn().mockResolvedValue(state),
      takeControl: vi.fn(),
    } as unknown as BrowserHost
    const resolveArtifactEntry = vi.fn().mockResolvedValue({
      entryPath: '/buddy/workspace/hello-world.html',
      rootPath: '/buddy/artifacts',
    })
    const webContents = { mainFrame: {} }
    const window = { webContents } as unknown as BrowserWindow
    registerBrowserDesktopIpc({
      data: { getSummary: async () => ({ cacheBytes: 0, cookieSiteCount: 0 }), clear: async () => ({ ok: true }) },
      screenshots: new BrowserScreenshotService(() => DEFAULT_BROWSER_PREFERENCES),
      getHost: () => host,
      getWindow: () => window,
      resolveArtifactEntry,
    })
    const trustedEvent = {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent

    await expect(invoke(DESKTOP_IPC_CHANNELS.browserOpenArtifact, trustedEvent, {
      artifactId: 'artifact-1',
      sessionId,
    })).resolves.toEqual(state)

    expect(resolveArtifactEntry).toHaveBeenCalledExactlyOnceWith({
      artifactId: 'artifact-1',
      conversationId: 'conversation-1',
    })
    expect(host.openLocalFile).toHaveBeenCalledExactlyOnceWith(sessionId, {
      entryPath: '/buddy/workspace/hello-world.html',
      rootPath: '/buddy/artifacts',
    })
    vi.mocked(host.getState).mockReturnValue({ ...state, conversationId: null })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserOpenArtifact, trustedEvent, {
      artifactId: 'artifact-1',
      sessionId,
    })).rejects.toThrow('require a conversation browser session')
  })
})

async function invoke(
  channel: string,
  event: IpcMainInvokeEvent,
  input: unknown,
): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (!handler)
    throw new Error(`Desktop IPC handler was not registered: ${channel}`)
  return handler(event, input)
}
