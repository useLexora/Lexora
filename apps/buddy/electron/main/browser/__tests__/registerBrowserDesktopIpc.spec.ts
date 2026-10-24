import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { BrowserHost } from '../BrowserHost'
import type { RegisterBrowserDesktopIpcOptions } from '../registerBrowserDesktopIpc'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC_CHANNELS } from '../../../shared/desktopApi'
import { registerBrowserDesktopIpc } from '../registerBrowserDesktopIpc'

const electron = vi.hoisted(() => ({
  fromId: vi.fn(),
  fromPartition: vi.fn(),
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>(),
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0' },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel, handler) => electron.handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
  },
  session: { fromPartition: electron.fromPartition },
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
  resolveFileEntry: RegisterBrowserDesktopIpcOptions['resolveFileEntry'] = async () => { throw new Error('unused') },
) {
  const webContents = { mainFrame: {} }
  registerBrowserDesktopIpc({
    data: { getSummary: async () => ({ cacheBytes: 0, cookieSiteCount: 0 }), clear: async () => ({ ok: true }) },
    screenshots: { capture: async () => { throw new Error('unused') } },
    getHost: () => Object.assign({ takeControl: vi.fn() }, host) as unknown as BrowserHost,
    getWindow: () => ({ webContents }) as unknown as BrowserWindow,
    resolveArtifactEntry,
    resolveFileEntry,
  })
  return { webContents, event: { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent }
}

describe('registerBrowserDesktopIpc', () => {
  it('rejects unsafe URLs, malformed commands and untrusted senders before host side effects', async () => {
    const host = {
      close: vi.fn(),
      navigate: vi.fn(),
      pickElement: vi.fn(),
      reload: vi.fn(),
    }
    const { webContents, event } = fixture(host)
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserNavigate, event, { sessionId, url: 'javascript:alert(1)' })).rejects.toThrow()
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserReload, event, { sessionId, extra: true })).rejects.toThrow()
    const input = { sessionId, requestId: '00000000-0000-4000-8000-000000000001' }
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserPickElement, event, { ...input, script: 'alert(1)' })).rejects.toThrow()
    const untrusted = { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserClose, untrusted, { sessionId })).rejects.toThrow('Untrusted Desktop IPC sender')
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserPickElement, { sender: webContents, senderFrame: {} } as unknown as IpcMainInvokeEvent, input)).rejects.toThrow('Untrusted Desktop IPC sender')
    expect(host.navigate).not.toHaveBeenCalled()
    expect(host.close).not.toHaveBeenCalled()
    expect(host.reload).not.toHaveBeenCalled()
    expect(host.pickElement).not.toHaveBeenCalled()
  })

  it('propagates an asynchronous retry failure through the reload request', async () => {
    const { event } = fixture({
      getState: () => state,
      reload: async () => {
        await Promise.resolve()
        throw new Error('Navigation preparation failed')
      },
    })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserReload, event, { sessionId }))
      .rejects
      .toThrow('Navigation preparation failed')
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

  it('opens a resolved file only in its owning conversation browser', async () => {
    let opened: unknown = null
    const target = { conversationId: 'conversation-1', path: '/workspace/page.html' }
    const entry = { rootPath: '/workspace', entryPath: target.path }
    const { event } = fixture({
      getState: () => state,
      openLocalFile: async (_id: string, value: unknown) => {
        opened = value
        return state
      },
    }, undefined, async (input) => {
      if (input.path !== target.path)
        throw new Error('DIRECTORY_NOT_AUTHORIZED')
      return entry
    })
    await expect(invoke(DESKTOP_IPC_CHANNELS.browserOpenFile, event, { sessionId, target: { ...target, conversationId: 'other' } })).rejects.toThrow('owning conversation')
    expect(opened).toBeNull()
    await invoke(DESKTOP_IPC_CHANNELS.browserOpenFile, event, { sessionId, target })
    expect(opened).toEqual(entry)
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
