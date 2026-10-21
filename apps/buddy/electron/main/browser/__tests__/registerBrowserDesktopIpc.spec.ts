import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { BrowserHost } from '../BrowserHost'
import type { RegisterBrowserDesktopIpcOptions } from '../registerBrowserDesktopIpc'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC_CHANNELS } from '../../../shared/desktopApi'
import { registerBrowserDesktopIpc } from '../registerBrowserDesktopIpc'

const electron = vi.hoisted(() => ({
  fromId: vi.fn(),
  fromPartition: vi.fn(),
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>(),
  openExternal: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0' },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel, handler) => electron.handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
  },
  session: { fromPartition: electron.fromPartition },
  shell: { openExternal: electron.openExternal, openPath: electron.openPath, showItemInFolder: electron.showItemInFolder },
  webContents: { fromId: electron.fromId },
}))

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

beforeEach(() => {
  electron.handlers.clear()
  vi.resetAllMocks()
})

function fixture(
  host: unknown,
  resolveArtifactEntry: RegisterBrowserDesktopIpcOptions['resolveArtifactEntry'] = async () => {
    throw new Error('unused')
  },
) {
  const webContents = { mainFrame: {} }
  registerBrowserDesktopIpc({
    data: { getSummary: async () => ({ cacheBytes: 0, cookieSiteCount: 0 }), clear: async () => ({ ok: true }) },
    screenshots: { capture: async () => { throw new Error('unused') } },
    getHost: () => Object.assign({ takeControl: vi.fn() }, host) as unknown as BrowserHost,
    getWindow: () => ({ webContents }) as unknown as BrowserWindow,
    resolveArtifactEntry,
  })
  return { webContents, event: { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent }
}

describe('registerBrowserDesktopIpc', () => {
  it('rejects unsafe URLs, malformed requests and untrusted senders before host side effects', async () => {
    const host = {
      close: vi.fn(),
      getState: () => state,
      navigate: vi.fn(async () => ({ ...state, url: 'https://example.com/' })),
      reload: vi.fn(),
    }
    const { event } = fixture(host)
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserNavigate, event, { sessionId, url: 'https://example.com' })).resolves.toMatchObject({ url: 'https://example.com/' })
    await invoke(DESKTOP_IPC_CHANNELS.browserReload, event, { sessionId })
    await invoke(DESKTOP_IPC_CHANNELS.browserClose, event, { sessionId })

    await expect(invoke(DESKTOP_IPC_CHANNELS.browserNavigate, event, { sessionId, url: 'javascript:alert(1)' })).rejects.toThrow()
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserReload, event, { sessionId, extra: true })).rejects.toThrow()
    const untrusted = { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserClose, untrusted, { sessionId })).rejects.toThrow('Untrusted Desktop IPC sender')
    expect(host.navigate).toHaveBeenCalledOnce()
    expect(host.close).toHaveBeenCalledOnce()
    expect(host.reload).toHaveBeenCalledOnce()
  })

  it('restricts element picking to fixed validated commands from the trusted main frame', async () => {
    const host = { pickElement: vi.fn(async () => ({ status: 'cancelled' })) }
    const { webContents, event } = fixture(host)
    const input = { sessionId, requestId: '00000000-0000-4000-8000-000000000001' }
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserPickElement, event, input)).resolves.toEqual({ status: 'cancelled' })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserPickElement, event, { ...input, script: 'alert(1)' })).rejects.toThrow()
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserPickElement, { sender: webContents, senderFrame: {} } as unknown as IpcMainInvokeEvent, input)).rejects.toThrow()
    expect(host.pickElement).toHaveBeenCalledOnce()
  })

  it('binds only a webview guest owned by the trusted renderer and requested session', async () => {
    const attachGuest = vi.fn()
    const partition = `buddy-browser:${sessionId}`
    const expectedSession = {}
    const { webContents, event } = fixture({ attachGuest, getGuestDescriptor: (id: string) => id === sessionId ? { partition, sessionId } : null })
    const guest = { getType: () => 'webview', hostWebContents: webContents, session: expectedSession }
    electron.fromId.mockReturnValue(guest)
    electron.fromPartition.mockImplementation((requested: string) => requested === partition ? expectedSession : {})
    await invoke(DESKTOP_IPC_CHANNELS.browserAttachGuest, event, { sessionId, webContentsId: 42 })
    expect(attachGuest).toHaveBeenCalledExactlyOnceWith(sessionId, guest)

    electron.fromId.mockReturnValueOnce({ ...guest, hostWebContents: { mainFrame: {} } })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserAttachGuest, event, { sessionId, webContentsId: 43 })).rejects.toThrow('Browser guest does not belong to the Desktop renderer')
    electron.fromId.mockReturnValueOnce({ ...guest, session: {} })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserAttachGuest, event, { sessionId, webContentsId: 44 })).rejects.toThrow('Browser guest does not belong to the requested session')
    expect(attachGuest).toHaveBeenCalledOnce()
  })

  it('takes human control before a renderer navigation command', async () => {
    let controller = 'agent'
    const navigationControllers: string[] = []
    const { event } = fixture({
      getState: () => ({ ...state, controller }),
      takeControl: () => { controller = 'human' },
      goBack: () => navigationControllers.push(controller),
    })
    await invoke(DESKTOP_IPC_CHANNELS.browserGoBack, event, { sessionId })
    expect(navigationControllers).toEqual(['human'])
  })

  it('opens local files and remote pages through the appropriate OS boundary, revealing only files', async () => {
    const filePath = resolve('/picked/space/site/index.html')
    let url = pathToFileURL(filePath).href
    const { event } = fixture({ getState: () => ({ ...state, url }) })
    electron.openPath.mockResolvedValue('')
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserOpenExternal, event, { sessionId })).resolves.toBe(true)
    expect(electron.openPath).toHaveBeenCalledExactlyOnceWith(filePath)
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserShowFileInFolder, event, { sessionId })).resolves.toBe(true)
    expect(electron.showItemInFolder).toHaveBeenCalledExactlyOnceWith(filePath)

    url = 'https://example.com/'
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserOpenExternal, event, { sessionId })).resolves.toBe(true)
    expect(electron.openExternal).toHaveBeenCalledExactlyOnceWith(url)
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserShowFileInFolder, event, { sessionId })).resolves.toBe(false)
    expect(electron.showItemInFolder).toHaveBeenCalledOnce()
  })

  it('resolves an artifact using the owning conversation and authorized local resource root', async () => {
    const host = {
      getState: vi.fn().mockReturnValue(state),
      openLocalFile: vi.fn().mockResolvedValue(state),
    }
    const entry = { entryPath: '/buddy/workspace/hello-world.html', rootPath: '/buddy/artifacts' }
    const resolveArtifactEntry = vi.fn().mockResolvedValue(entry)
    const { event } = fixture(host, resolveArtifactEntry)
    await invoke(DESKTOP_IPC_CHANNELS.browserOpenArtifact, event, { artifactId: 'artifact-1', sessionId })
    expect(resolveArtifactEntry).toHaveBeenCalledExactlyOnceWith({ artifactId: 'artifact-1', conversationId: 'conversation-1' })
    expect(host.openLocalFile).toHaveBeenCalledExactlyOnceWith(sessionId, entry)
    host.getState.mockReturnValue({ ...state, conversationId: null })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserOpenArtifact, event, { artifactId: 'artifact-1', sessionId })).rejects.toThrow('require a conversation browser session')
    expect(host.openLocalFile).toHaveBeenCalledOnce()
  })
})

async function invoke(channel: string, event: IpcMainInvokeEvent, input: unknown): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (!handler)
    throw new Error(`Desktop IPC handler was not registered: ${channel}`)
  return handler(event, input)
}
