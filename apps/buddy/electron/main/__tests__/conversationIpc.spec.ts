import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { conversationsRpc } from '../../../shared/conversation/conversationApi'
import { conversationArchiveRpc } from '../../../shared/conversation/conversationArchiveApi'
import { createConversationApi } from '../../preload/local-chat/conversation'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { registerConversationIpc } from '../local-chat/conversation'
import { createLocalChatIpcContext } from '../local-chat/registrar'

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
  const webContents = { mainFrame: {} }
  return {
    handlers,
    webContents,
    invoke: async (channel: string, input: unknown) => {
      const handler = handlers.get(channel)
      if (!handler)
        throw new Error('IPC handler is missing')
      return handler({ sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent, input)
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => electron.handlers.set(channel, handler),
    removeHandler: (channel: string) => electron.handlers.delete(channel),
  },
  ipcRenderer: { invoke: electron.invoke },
}))

describe('conversation archive IPC contract', () => {
  it.each([
    ['archive', LOCAL_CHAT_IPC_CHANNELS.conversationsArchive],
    ['restoreArchive', LOCAL_CHAT_IPC_CHANNELS.conversationsRestoreArchive],
    ['deleteArchived', LOCAL_CHAT_IPC_CHANNELS.conversationsDeleteArchived],
  ] as const)('preserves the fixed revision and refuses missing CAS for %s', async (method, channel) => {
    const received: unknown[] = []
    const context = createLocalChatIpcContext({
      getLanguage: () => 'zh-CN',
      getWindow: () => ({ webContents: electron.webContents } as unknown as BrowserWindow),
      openModelSnapshotDirectory: async () => {},
      readWebCredential: async () => null,
      runtime: {
        state: {},
        onNotification: () => () => {},
        onStateChange: () => () => {},
        restart: async () => {},
        request: async (name, input) => {
          expect(name).toBe(conversationArchiveRpc[method].method)
          received.push(conversationArchiveRpc[method].input.parse(input))
          return true
        },
      },
    })
    registerConversationIpc(context)
    const api = createConversationApi()
    try {
      await expect(api.conversations[method]('task-1', 0)).resolves.toBe(true)
      await expect(api.conversations[method]('task-1', 7)).resolves.toBe(true)
      for (const expectedRevision of [undefined, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1]) {
        await expect(electron.invoke(channel, { conversationId: 'task-1', expectedRevision })).rejects.toThrow('VALIDATION_FAILED')
      }
      expect(received).toEqual([
        { conversationId: 'task-1', expectedRevision: 0 },
        { conversationId: 'task-1', expectedRevision: 7 },
      ])
    }
    finally { context.dispose() }
  })
})

describe('conversation deletion IPC contract', () => {
  it('preserves the preload revision condition through strict main validation', async () => {
    const received: unknown[] = []
    const context = createLocalChatIpcContext({
      getLanguage: () => 'zh-CN',
      getWindow: () => ({ webContents: electron.webContents } as unknown as BrowserWindow),
      openModelSnapshotDirectory: async () => {},
      readWebCredential: async () => null,
      runtime: {
        state: {},
        onNotification: () => () => {},
        onStateChange: () => () => {},
        restart: async () => {},
        request: async (method, input) => {
          expect(method).toBe(conversationsRpc.delete.method)
          received.push(conversationsRpc.delete.input.parse(input))
          return true
        },
      },
    })
    registerConversationIpc(context)
    const api = createConversationApi()
    try {
      await expect(api.conversations.delete('task-1', 0)).resolves.toBe(true)
      await expect(api.conversations.delete('task-1', 7)).resolves.toBe(true)
      await expect(api.conversations.delete('task-1')).resolves.toBe(true)
      expect(received).toEqual([
        { conversationId: 'task-1', expectedRevision: 0 },
        { conversationId: 'task-1', expectedRevision: 7 },
        { conversationId: 'task-1' },
      ])

      for (const revision of [-1, 1.5, '7']) {
        await expect(electron.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsDelete, {
          conversationId: 'task-1',
          expectedRevision: revision,
        })).rejects.toThrow('VALIDATION_FAILED')
      }
      await expect(electron.invoke(LOCAL_CHAT_IPC_CHANNELS.conversationsDelete, {
        conversationId: 'task-1',
        expectedRevision: 7,
        unexpected: true,
      })).rejects.toThrow('VALIDATION_FAILED')
      expect(received).toHaveLength(3)
    }
    finally {
      context.dispose()
    }
  })
})
