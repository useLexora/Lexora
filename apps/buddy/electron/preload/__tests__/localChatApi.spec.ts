import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { createLocalChatApi } from '../localChatApi'

const electron = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: unknown, value: unknown) => void>>(),
  invoke: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: electron.invoke,
    on: (channel: string, listener: (event: unknown, value: unknown) => void) => {
      if (!electron.listeners.has(channel))
        electron.listeners.set(channel, new Set())
      electron.listeners.get(channel)!.add(listener)
    },
    off: (channel: string, listener: (event: unknown, value: unknown) => void) => {
      electron.listeners.get(channel)?.delete(listener)
    },
  },
}))
beforeEach(() => {
  electron.listeners.clear()
  electron.invoke.mockReset()
})

describe('local chat preload boundary', () => {
  it('delivers metrics change payloads without Electron event access and unsubscribes', () => {
    const api = createLocalChatApi()
    const received: unknown[] = []
    const stop = api.runs.onMetricsChanged((...args) => received.push(args))
    const notice = { conversationId: 'conversation-1', revision: 3 }
    for (const listener of electron.listeners.get(LOCAL_CHAT_IPC_CHANNELS.runsMetricsChanged) ?? [])
      listener({ privileged: true }, notice)
    stop()
    for (const listener of electron.listeners.get(LOCAL_CHAT_IPC_CHANNELS.runsMetricsChanged) ?? [])
      listener({ privileged: true }, { ...notice, revision: 4 })
    expect(received).toEqual([[notice]])
  })

  it('passes only payloads to subscribers and releases each subscription independently', () => {
    const api = createLocalChatApi()
    const received: unknown[] = []
    const stop = api.automations.onChanged((...args) => received.push(args))
    const retained = api.automations.onChanged(id => received.push(id))
    const publish = () => {
      for (const listener of electron.listeners.get(LOCAL_CHAT_IPC_CHANNELS.automationChanged) ?? [])
        listener({ privileged: true }, 'automation-1')
    }
    publish()
    stop()
    publish()
    retained()
    publish()
    expect(received).toEqual([['automation-1'], 'automation-1', 'automation-1'])
    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.values(api).every(Object.isFrozen)).toBe(true)
  })

  it('snapshots referenced resource IDs before invoking file selection', async () => {
    const api = createLocalChatApi()
    electron.invoke.mockResolvedValue([])
    const resourceIds = ['resource-1']
    const result = api.composerResources.selectFiles('draft-1', resourceIds)
    resourceIds.push('resource-2')
    await expect(result).resolves.toEqual([])
    expect(electron.invoke).toHaveBeenCalledWith(LOCAL_CHAT_IPC_CHANNELS.composerResourcesSelectFiles, {
      draftId: 'draft-1',
      referencedResourceIds: ['resource-1'],
    })
  })
})
