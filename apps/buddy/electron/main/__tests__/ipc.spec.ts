import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { LexoraConfigStore } from '../config/LexoraConfigStore'
import { deferred } from '@buddy-tests/deferred'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDesktopIpc } from '../ipc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>(),
  writeText: vi.fn(),
  write: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', isPackaged: false },
  clipboard: { writeText: electron.writeText, write: electron.write },
  ClipboardItem: class {
    readonly values: Record<string, string>
    constructor(values: Record<string, string>) { this.values = values }
  },
  ipcMain: {
    handle: vi.fn((channel, handler) => electron.handlers.set(channel, handler)),
  },
}))

beforeEach(() => {
  electron.handlers.clear()
  electron.writeText.mockReset().mockResolvedValue(undefined)
  electron.write.mockReset().mockResolvedValue(undefined)
})

function fixture() {
  const webContents = { mainFrame: {} }
  let window = { webContents } as unknown as BrowserWindow | null
  registerDesktopIpc({
    checkForUpdates: vi.fn(),
    configPath: '/home/example/.lexora/config.toml',
    runtimeProfile: 'test',
    configStore: {
      read: vi.fn(),
      update: vi.fn(),
    } as unknown as LexoraConfigStore,
    executeCommand: vi.fn(),
    getSandboxStatus: async () => 'available',
    setupSandbox: async () => 'cancelled',
    getWindow: () => window,
    onConfigUpdated: vi.fn(),
    openFeedbackIssue: vi.fn(),
    openReleasePage: vi.fn(),
  })
  const trustedEvent = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
  const untrustedEvent = { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent
  return { write: electron.handlers.get('lexora:clipboard:write-text')!, trustedEvent, untrustedEvent, close: () => {
    window = null
  } }
}

describe('registerDesktopIpc', () => {
  it('writes plain text or both rich formats atomically', async () => {
    const f = fixture()
    await expect(f.write(f.trustedEvent, { text: '完整回复' })).resolves.toBeUndefined()
    expect(electron.writeText).toHaveBeenCalledExactlyOnceWith('完整回复')
    const html = '<blockquote data-lexora-reference="opaque-token">选中文字</blockquote>'
    await expect(f.write(f.trustedEvent, { text: '选中文字', html })).resolves.toBeUndefined()
    expect(electron.write.mock.calls).toEqual([[[{ values: { 'text/plain': '选中文字', 'text/html': html } }]]])
    expect(electron.writeText).toHaveBeenCalledOnce()
  })

  it('rejects malformed requests, foreign windows and child frames before clipboard I/O', async () => {
    const f = fixture()
    for (const input of [null, {}, { text: 1 }, { text: '回复', html: 1 }, { text: '回复', unexpected: true }, { text: '回复', html: 'x'.repeat(4 * 1024 * 1024 + 1) }])
      await expect(f.write(f.trustedEvent, input)).rejects.toThrow()
    const childFrame = { ...f.trustedEvent, senderFrame: {} } as IpcMainInvokeEvent
    for (const event of [f.untrustedEvent, childFrame]) {
      await expect(f.write(event, { text: '回复' })).rejects.toThrow('Untrusted Desktop IPC sender')
      await expect(f.write(event, { text: '回复', html: '<p>回复</p>' })).rejects.toThrow('Untrusted Desktop IPC sender')
    }
    for (const channel of ['lexora:app:get-sandbox-status', 'lexora:app:setup-sandbox'])
      await expect(electron.handlers.get(channel)!(f.untrustedEvent)).rejects.toThrow('Untrusted Desktop IPC sender')
    f.close()
    await expect(f.write(f.trustedEvent, { text: '回复' })).rejects.toThrow('Untrusted Desktop IPC sender')
    expect(electron.writeText).not.toHaveBeenCalled()
    expect(electron.write).not.toHaveBeenCalled()
  })

  it.each(['plain', 'rich'] as const)('waits for native %s clipboard completion and propagates failures', async (format) => {
    const f = fixture()
    const native = format === 'plain' ? electron.writeText : electron.write
    const input = format === 'plain' ? { text: '回复' } : { text: '回复', html: '<p>回复</p>' }
    const pending = deferred<void>()
    native.mockReturnValueOnce(pending.promise)
    let settled = false
    const result = Promise.resolve(f.write(f.trustedEvent, input)).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    pending.resolve()
    await result
    expect(settled).toBe(true)
    native.mockRejectedValueOnce(new Error('Native clipboard unavailable'))
    await expect(f.write(f.trustedEvent, input)).rejects.toThrow('Native clipboard unavailable')
  })
})
