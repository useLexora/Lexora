import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { LexoraConfigStore } from '../config/LexoraConfigStore'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDesktopIpc } from '../ipc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>(),
  writeText: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0' },
  clipboard: { writeText: electron.writeText },
  ipcMain: {
    handle: vi.fn((channel, handler) => electron.handlers.set(channel, handler)),
  },
}))

beforeEach(() => {
  electron.handlers.clear()
})

describe('registerDesktopIpc', () => {
  it('exposes clipboard writes and sandbox status to the trusted Renderer only', async () => {
    const webContents = { mainFrame: {} }
    const window = { webContents } as unknown as BrowserWindow
    registerDesktopIpc({
      checkForUpdates: vi.fn(),
      configPath: '/home/example/.lexora/config.toml',
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
    const writeText = electron.handlers.get('lexora:clipboard:write-text')

    if (!writeText)
      throw new Error('Clipboard IPC handler was not registered')

    const trustedEvent = {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent
    const untrustedEvent = {
      sender: {},
      senderFrame: {},
    } as unknown as IpcMainInvokeEvent

    expect(writeText(trustedEvent, { text: '完整回复' })).toBeUndefined()
    expect(electron.writeText).toHaveBeenCalledExactlyOnceWith('完整回复')
    expect(() => writeText(trustedEvent, { text: '回复', unexpected: true })).toThrow()
    expect(() => writeText(untrustedEvent, { text: '回复' })).toThrow(
      'Untrusted Desktop IPC sender',
    )
    expect(electron.writeText).toHaveBeenCalledOnce()
    const readSandboxStatus = electron.handlers.get('lexora:app:get-sandbox-status')
    if (!readSandboxStatus)
      throw new Error('Sandbox status IPC handler was not registered')
    await expect(readSandboxStatus(trustedEvent)).resolves.toBe('available')
    await expect(readSandboxStatus(untrustedEvent)).rejects.toThrow('Untrusted Desktop IPC sender')
    const setupSandbox = electron.handlers.get('lexora:app:setup-sandbox')
    if (!setupSandbox)
      throw new Error('Sandbox setup IPC handler was not registered')
    await expect(setupSandbox(trustedEvent)).resolves.toBe('cancelled')
    await expect(setupSandbox(untrustedEvent)).rejects.toThrow('Untrusted Desktop IPC sender')

    const getInfo = electron.handlers.get('lexora:app:get-info')
    if (!getInfo)
      throw new Error('Get info IPC handler was not registered')
    const info = await (getInfo(trustedEvent) as Promise<unknown>) as Record<string, unknown>
    expect(info).toMatchObject({
      configPath: '/home/example/.lexora/config.toml',
      version: '0.1.0',
      systemProfile: {
        username: expect.any(String),
        displayName: expect.any(String),
        hostname: expect.any(String),
      },
    })
  })
})
