import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { DesktopRuntimeGateway } from '../localChatIpc'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { registerLocalChatIpc } from '../localChatIpc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>(),
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel, handler) => electron.handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
  },
}))

beforeEach(() => {
  electron.handlers.clear()
})

describe('registerLocalChatIpc', () => {
  it('reveals only the web credential to the trusted main frame without runtime forwarding', async () => {
    const webContents = { mainFrame: {} }
    let credential: unknown = 'fixture-private-key'
    let reads = 0
    registerLocalChatIpc({
      getLanguage: () => 'zh-CN',
      getWindow: () => ({ webContents } as unknown as BrowserWindow),
      openModelSnapshotDirectory: async () => {},
      readWebCredential: async () => {
        reads++
        return credential
      },
      runtime: { state: {}, onNotification: () => () => {}, onStateChange: () => () => {}, restart: async () => {}, request: async () => { throw new Error('must not forward secrets to runtime') } },
    })
    const reveal = electron.handlers.get(LOCAL_CHAT_IPC_CHANNELS.webCredentialReveal)!
    const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
    await expect(reveal({ ...event, senderFrame: {} } as IpcMainInvokeEvent, undefined)).rejects.toThrow()
    expect(reads).toBe(0)
    await expect(reveal(event, undefined)).resolves.toBe('fixture-private-key')
    credential = { private: 'invalid-private-key' }
    await expect(reveal(event, undefined)).rejects.toThrow('VALIDATION_FAILED')
  })

  it('opens only the fixed model snapshot directory from the trusted main frame', async () => {
    const webContents = { mainFrame: {} }
    const openModelSnapshotDirectory = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn()
    registerLocalChatIpc({
      getLanguage: () => 'zh-CN',
      getWindow: () => ({ webContents } as unknown as BrowserWindow),
      openModelSnapshotDirectory,
      readWebCredential: async () => null,
      runtime: {
        state: {},
        onNotification: () => () => {},
        onStateChange: () => () => {},
        restart: async () => {},
        request,
      },
    })
    const openDirectory = electron.handlers.get(
      LOCAL_CHAT_IPC_CHANNELS.providersOpenModelSnapshotDirectory,
    )!
    const event = {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent

    await expect(openDirectory(
      { ...event, senderFrame: {} } as IpcMainInvokeEvent,
      undefined,
    )).rejects.toThrow()
    expect(openModelSnapshotDirectory).not.toHaveBeenCalled()
    await expect(openDirectory(event, undefined)).resolves.toBeUndefined()
    expect(openModelSnapshotDirectory).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
  })

  it('validates and forwards authoritative automation previews', async () => {
    const preview = {
      frequency: {
        cadence: 'daily',
        kind: 'calendar',
        localTime: '09:30',
        timezone: 'Asia/Shanghai',
      },
      nextRunAt: '2026-08-24T01:30:00.000Z',
      normalizedTiming: {
        activeFrom: null,
        activeUntil: null,
        schedule: {
          cadence: 'daily',
          kind: 'calendar',
          localTime: '09:30',
        },
        timezone: 'Asia/Shanghai',
      },
      samples: ['2026-08-24T01:30:00.000Z'],
      valid: true,
    }
    const request = vi.fn().mockResolvedValue(preview)
    const runtime: DesktopRuntimeGateway = {
      onNotification: () => () => {},
      onStateChange: () => () => {},
      request,
      restart: vi.fn(),
      state: { phase: 'ready' },
    }
    const webContents = { mainFrame: {} }
    const window = { webContents } as unknown as BrowserWindow
    registerLocalChatIpc({
      readWebCredential: async () => null,
      getLanguage: () => 'zh-CN',
      getWindow: () => window,
      openModelSnapshotDirectory: async () => {},
      runtime,
    })
    const handlePreview = electron.handlers.get(LOCAL_CHAT_IPC_CHANNELS.automationsPreview)
    if (!handlePreview)
      throw new Error('automation preview IPC handler was not registered')
    const event = {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent
    const input = {
      sampleCount: 1,
      timing: preview.normalizedTiming,
    }

    await expect(handlePreview(event, input)).resolves.toEqual(preview)
    expect(request).toHaveBeenCalledWith('automations.preview', input, {
      timeoutMs: 30_000,
      requestId: expect.any(String),
    })
    await expect(handlePreview(event, {
      ...input,
      unexpected: true,
    })).rejects.toThrow('VALIDATION_FAILED')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('accepts only the public manual-run result contract', async () => {
    const occurrence = {
      automationId: 'automation-1',
      automationRevision: 1,
      boundAt: null,
      coalescedMissedCount: 0,
      conversationId: null,
      errorCode: null,
      errorSummary: null,
      finishedAt: null,
      id: 'occurrence-1',
      queuedAt: '2026-08-24T01:00:00.000Z',
      runId: null,
      scheduledFor: '2026-08-24T01:00:00.000Z',
      status: 'queued',
      triggerKind: 'manual',
    }
    const result = { occurrence, outcome: 'started' }
    const request = vi.fn().mockResolvedValue(result)
    const runtime: DesktopRuntimeGateway = {
      onNotification: () => () => {},
      onStateChange: () => () => {},
      request,
      restart: vi.fn(),
      state: { phase: 'ready' },
    }
    const webContents = { mainFrame: {} }
    const window = { webContents } as unknown as BrowserWindow
    registerLocalChatIpc({
      readWebCredential: async () => null,
      getLanguage: () => 'zh-CN',
      getWindow: () => window,
      openModelSnapshotDirectory: async () => {},
      runtime,
    })
    const runNow = electron.handlers.get(LOCAL_CHAT_IPC_CHANNELS.automationsRunNow)
    if (!runNow)
      throw new Error('automation run-now IPC handler was not registered')
    const event = {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent
    const input = {
      automationId: 'automation-1',
      expectedRevision: 1,
      requestId: 'run-now-1',
    }

    await expect(runNow(event, input)).resolves.toEqual(result)
    expect(request).toHaveBeenCalledWith('automations.runNow', input, {
      timeoutMs: 30_000,
      requestId: expect.any(String),
    })

    request.mockResolvedValueOnce({
      ...result,
      occurrence: { ...occurrence, leaseOwner: 'runtime-private-owner' },
    })
    await expect(runNow(event, input)).rejects.toThrow('RUNTIME_PROTOCOL_ERROR')
  })

  it('sanitizes historical and live run events before sending them to Renderer', async () => {
    const rawEvent = {
      createdAt: '2026-08-16T00:00:00.000Z',
      payload: {
        id: 'approval-1',
        kind: 'shell',
        payload: { arguments: { apiKey: 'secret-value' } },
        status: 'pending',
        summary: 'Run command',
        toolCallId: 'tool-1',
      },
      runId: 'run-1',
      sequence: 1,
      type: 'approval.requested',
    }
    let notify: ((notification: { method: string, params: unknown }) => void) | undefined
    const runtime: DesktopRuntimeGateway = {
      onNotification(listener) {
        notify = listener
        return () => {}
      },
      onStateChange: () => () => {},
      request: vi.fn().mockResolvedValue([rawEvent]),
      restart: vi.fn(),
      state: { phase: 'ready' },
    }
    const send = vi.fn()
    const webContents = {
      isDestroyed: () => false,
      mainFrame: {},
      send,
    }
    const window = {
      isDestroyed: () => false,
      webContents,
    } as unknown as BrowserWindow
    registerLocalChatIpc({
      readWebCredential: async () => null,
      getLanguage: () => 'zh-CN',
      getWindow: () => window,
      openModelSnapshotDirectory: async () => {},
      runtime,
    })
    const listEvents = electron.handlers.get(LOCAL_CHAT_IPC_CHANNELS.runsListEvents)
    if (!listEvents)
      throw new Error('run event IPC handler was not registered')

    const historical = await listEvents({
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent, { runId: 'run-1' })
    notify?.({ method: 'run.event', params: rawEvent })

    const expected = {
      ...rawEvent,
      payload: {
        id: 'approval-1',
        kind: 'shell',
        status: 'pending',
        summary: 'Run command',
        toolCallId: 'tool-1',
      },
    }
    expect(historical).toEqual([expected])
    expect(send).toHaveBeenCalledWith(LOCAL_CHAT_IPC_CHANNELS.runEvent, expected)
    expect(JSON.stringify([historical, send.mock.calls])).not.toContain('secret-value')
  })

  it('rejects an approval response whose payload is outside the public review contract', async () => {
    const runtime: DesktopRuntimeGateway = {
      onNotification: () => () => {},
      onStateChange: () => () => {},
      request: vi.fn().mockResolvedValue([{
        createdAt: '2026-08-16T00:00:00.000Z',
        id: 'approval-1',
        kind: 'mcp',
        payload: { command: 'echo secret-value', toolName: 'bash' },
        resolvedAt: null,
        runId: 'run-1',
        status: 'pending',
        summary: 'Use connector',
        toolCallId: 'tool-1',
      }]),
      restart: vi.fn(),
      state: { phase: 'ready' },
    }
    const webContents = { mainFrame: {} }
    const window = { webContents } as unknown as BrowserWindow
    registerLocalChatIpc({
      readWebCredential: async () => null,
      getLanguage: () => 'zh-CN',
      getWindow: () => window,
      openModelSnapshotDirectory: async () => {},
      runtime,
    })
    const listApprovals = electron.handlers.get(LOCAL_CHAT_IPC_CHANNELS.approvalsList)
    if (!listApprovals)
      throw new Error('approval IPC handler was not registered')

    await expect(listApprovals({
      sender: webContents,
      senderFrame: webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent, {})).rejects.toThrow('RUNTIME_PROTOCOL_ERROR')
  })
})
