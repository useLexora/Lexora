import type { BrowserWindow } from 'electron'
import type { DesktopEnvironment } from '../typing'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC_CHANNELS } from '../../../shared/desktopApi'
import { DesktopWindowHost } from '../DesktopWindowHost'

const native = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false }, nativeTheme: { shouldUseDarkColors: false }, screen: { getAllDisplays: () => [] } }))
vi.mock('../../window', () => ({ createDesktopWindow: native.create, applyDesktopWindowAppearance: vi.fn() }))
vi.mock('../../desktopWindowState', () => ({
  DesktopWindowStateStore: class {
    async read() { return null }
  },
  resolveVisibleWindowPlacement: () => null,
}))

beforeEach(() => native.create.mockReset())

async function fixture(beforeInitialize?: (host: DesktopWindowHost) => Promise<void>) {
  const window = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { send: vi.fn() }),
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  })
  native.create.mockReturnValue({ window: window as unknown as BrowserWindow, load: async () => {} })
  const record = vi.fn()
  const host = new DesktopWindowHost({
    paths: { windowState: 'unused' },
    events: { publish: vi.fn() },
    diagnostics: { record },
    initialLaunchIntent: 'background',
  } as unknown as DesktopEnvironment)
  await beforeInitialize?.(host)
  await host.initialize({ isQuitting: () => false, minimizeToTrayOnClose: () => true, onCloseToQuit: vi.fn(), onHidden: vi.fn(), onRecoveryExhausted: vi.fn(), onWindowCreated: vi.fn() })
  return { host, window, record }
}

describe('notification window targets', () => {
  it('keeps an early click until the renderer subscribes and brings the window forward', async () => {
    const { host, window } = await fixture(host => host.openTarget({ conversationId: 'early', runId: 'run' }))
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(host.getPendingOpenTarget()).toMatchObject({ conversationId: 'early', runId: 'run' })
  })

  it('reports failures, ignores old acknowledgements and waits for a reloaded renderer', async () => {
    const { host, window } = await fixture()
    host.getPendingOpenTarget()
    await host.openTarget({ conversationId: 'a', runId: 'run-a' })
    const a = host.getPendingOpenTarget()!
    await host.openTarget({ conversationId: 'b', runId: 'run-b' })
    const b = host.getPendingOpenTarget()!
    host.completeOpenTarget(a.requestId, 'opened')
    expect(host.getPendingOpenTarget()).toEqual(b)
    host.completeOpenTarget(b.requestId, 'failed')
    expect(host.getPendingOpenTarget()).toBeNull()
    expect(window.webContents.send).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.appOpenTarget, b)
    window.webContents.emit('did-start-navigation', {}, 'url', false, true)
    window.webContents.send.mockClear()
    await host.openTarget({ conversationId: 'c', runId: 'run-c' })
    expect(window.webContents.send).not.toHaveBeenCalled()
    const c = host.getPendingOpenTarget()!
    expect(c.conversationId).toBe('c')
    host.completeOpenTarget(c.requestId, 'opened')
    expect(host.getPendingOpenTarget()).toBeNull()
  })

  it('records a window activation failure and retries showing without dropping the target', async () => {
    const { host, window, record } = await fixture()
    host.getPendingOpenTarget()
    window.show.mockImplementationOnce(() => {
      throw new Error('window activation failed')
    })
    await host.openTarget({ conversationId: 'a', runId: 'run-a' })
    await vi.waitFor(() => expect(window.show).toHaveBeenCalledTimes(2))
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: 'notification.target.open_failed' }))
    expect(host.getPendingOpenTarget()).toMatchObject({ conversationId: 'a' })
    expect(window.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.appOpenTarget, expect.objectContaining({ conversationId: 'a' }))
  })
})
