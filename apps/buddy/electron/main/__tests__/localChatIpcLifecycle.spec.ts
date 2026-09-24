import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { DesktopRuntimeGateway } from '../localChatIpc'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { registerLocalChatIpc } from '../localChatIpc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>(),
  select: vi.fn(),
}))
vi.mock('electron', () => ({
  dialog: { showOpenDialog: electron.select },
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) => electron.handlers.set(channel, handler),
    removeHandler: (channel: string) => electron.handlers.delete(channel),
  },
}))

beforeEach(() => {
  electron.handlers.clear()
  electron.select.mockReset()
})

function setup(request: DesktopRuntimeGateway['request']) {
  const notificationListeners = new Set<(notification: { method: string, params: unknown }) => void>()
  const stateListeners = new Set<(state: unknown) => void>()
  const sent: unknown[] = []
  const webContents = { mainFrame: {}, isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) }
  const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
  const dispose = registerLocalChatIpc({
    getLanguage: () => 'zh-CN',
    getWindow: () => window,
    openModelSnapshotDirectory: async () => {},
    readWebCredential: async () => null,
    runtime: {
      state: {},
      request,
      restart: async () => {},
      onNotification: (listener) => {
        notificationListeners.add(listener)
        return () => {
          notificationListeners.delete(listener)
        }
      },
      onStateChange: (listener) => {
        stateListeners.add(listener)
        return () => {
          stateListeners.delete(listener)
        }
      },
    },
  })
  return { dispose, event, sent, notificationListeners, stateListeners }
}

describe('local chat IPC lifecycle and host authorization', () => {
  it('consumes native directory selections once and rejects renderer verification claims', async () => {
    const requests: unknown[] = []
    const { event } = setup(async (_method, input) => {
      requests.push(input)
      throw new Error('fixture storage unavailable')
    })
    electron.select.mockResolvedValue({ canceled: false, filePaths: ['/tmp/space-fixture'] })
    await expect(electron.handlers.get(LOCAL_CHAT_IPC_CHANNELS.spacesSelectDirectory)!(event)).resolves.toBe('/tmp/space-fixture')
    const create = electron.handlers.get(LOCAL_CHAT_IPC_CHANNELS.spacesCreate)!
    const input = { memoryScope: 'space_only', name: 'Fixture', primaryDirectory: { id: null, root: '/tmp/space-fixture' } }
    await expect(create(event, { ...input, primaryDirectorySelectionVerified: true })).rejects.toThrow('VALIDATION_FAILED')
    expect(requests).toEqual([])
    await expect(create(event, input)).rejects.toThrow('LOCAL_CHAT_OPERATION_FAILED')
    await expect(create(event, input)).rejects.toThrow('LOCAL_CHAT_OPERATION_FAILED')
    expect(requests).toEqual([
      { ...input, primaryDirectorySelectionVerified: true },
      { ...input, primaryDirectorySelectionVerified: false },
    ])
  })

  it('retains long provider login timeouts and public retryable errors', async () => {
    const calls: unknown[] = []
    const { event } = setup(async (method, input, options) => {
      calls.push({ method, input, options })
      throw Object.assign(new Error('fixture provider error'), { data: { code: 'PROVIDER_UNAVAILABLE' } })
    })
    await expect(electron.handlers.get(LOCAL_CHAT_IPC_CHANNELS.providersLogin)!(event, {
      providerId: 'fixture-provider',
      authType: 'oauth',
    })).rejects.toThrow('LEXORA_LOCAL_CHAT_ERROR:PROVIDER_UNAVAILABLE:1')
    expect(calls).toEqual([{
      method: 'providers.login',
      input: { providerId: 'fixture-provider', authType: 'oauth' },
      options: { timeoutMs: 600_000, requestId: expect.any(String) },
    }])
  })

  it('stops forwarding runtime notifications and removes all channels on disposal', () => {
    const { dispose, notificationListeners, stateListeners, sent } = setup(async () => ({}))
    const state = { lastError: null, pid: 123, restartAttempt: 0, status: 'ready' }
    for (const listener of notificationListeners) {
      listener({ method: 'automation.changed', params: { automationId: 'automation-1' } })
      listener({ method: 'automation.changed', params: { automationId: 1 } })
    }
    for (const listener of stateListeners)
      listener(state)
    expect(sent).toEqual([
      [LOCAL_CHAT_IPC_CHANNELS.automationChanged, 'automation-1'],
      [LOCAL_CHAT_IPC_CHANNELS.runtimeStateChanged, state],
    ])
    dispose()
    expect(notificationListeners.size).toBe(0)
    expect(stateListeners.size).toBe(0)
    expect(electron.handlers.size).toBe(0)
  })
})
