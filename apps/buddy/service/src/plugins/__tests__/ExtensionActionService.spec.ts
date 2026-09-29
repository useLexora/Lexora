import type { ExtensionAgentDescriptor, ExtensionAgentInvocation } from '../../../../shared/extensions/extensionAgent'
import type { RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeRpcPeer } from '../../../../platform/ipc/runtimeRpcPeer'
import { extensionActionRpc } from '../../../../shared/extensions/extensionActionApi'
import { extensionAgentRpc } from '../../../../shared/extensions/extensionAgent'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createExtensionInvocationRepository } from '../../storage/extensionInvocationRepository'
import { ExtensionActionService } from '../ExtensionActionService'
import { ExtensionAgentRuntime } from '../ExtensionAgentRuntime'

describe('extension action dispatch', () => {
  it.each([90000, 121000])('gives manual actions their execution budget after queueing over RPC for duration %s', async (duration) => {
    vi.useFakeTimers()
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const descriptor: ExtensionAgentDescriptor = {
      id: 'tests.actions',
      name: 'Actions',
      revision: 'package',
      configurationRevision: 'config',
      agent: { instructions: '', tools: [], actions: [{ id: 'tests.actions.manual', title: 'Manual', triggers: ['user'] }] },
    }
    createConversationRepository(database).create({ id: 'task', branchId: 'branch', title: null, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: new Date().toISOString() })
    let toHost: (message: unknown) => void = () => {}
    let toService: (message: unknown) => void = () => {}
    const host = new RuntimeRpcPeer({ transport: { postMessage: message => toService(message), subscribe: (listener) => {
      toHost = listener
      return () => {
        toHost = () => {}
      }
    } } })
    const peer = new RuntimeRpcPeer({ transport: { postMessage: message => toHost(message), subscribe: (listener) => {
      toService = listener
      return () => {
        toService = () => {}
      }
    } } })
    host.onRequest(extensionAgentRpc.list, () => [descriptor])
    let manualSignal: AbortSignal | undefined
    host.onRequest(extensionAgentRpc.invoke, (raw, signal) => {
      const manual = 'action' in (raw as ExtensionAgentInvocation)
      if (manual)
        manualSignal = signal
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>
        const cancel = () => {
          clearTimeout(timer)
          reject(signal!.reason)
        }
        timer = setTimeout(() => {
          signal!.removeEventListener('abort', cancel)
          resolve({ status: 'completed' })
        }, manual ? duration : 60000)
        signal!.addEventListener('abort', cancel, { once: true })
      })
    })
    const runtime = new ExtensionAgentRuntime({ rpc: peer, createHandlers: () => ({ 'task.get': async () => null, 'task.messages': async () => [], 'task.rename': async () => null, 'models.generateText': async () => null }) })
    const service = new ExtensionActionService({ runtime, repository: createExtensionInvocationRepository(database), capture: () => ({ branchId: 'branch', sourceMessageId: null }) })
    peer.onRequest(extensionActionRpc.invoke.method, (input, signal) => service.invoke(extensionActionRpc.invoke.input.parse(input), signal))
    try {
      const tools = Array.from({ length: 4 }, () => runtime.invoke(descriptor, { tool: 'tests.actions.tool', input: {} }, { conversationId: 'task', runId: 'run' }, new AbortController().signal))
      let result: unknown
      const manual = host.request(extensionActionRpc.invoke.method, { conversationId: 'task', extensionId: descriptor.id, actionId: 'tests.actions.manual' }, null).then(value => result = value, error => result = error)
      await vi.advanceTimersByTimeAsync(0)
      expect(manualSignal).toBeUndefined()
      await vi.advanceTimersByTimeAsync(60000)
      await Promise.all(tools)
      expect(manualSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(75000)
      expect(result).toBeUndefined()
      expect(manualSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(duration <= 120000 ? 15000 : 45000)
      await manual
      if (duration <= 120000) {
        expect(result).toEqual({ status: 'completed' })
        expect(database.prepare('SELECT status FROM extension_invocations').all()).toEqual([{ status: 'completed' }])
      }
      else {
        expect(manualSignal?.aborted).toBe(true)
        expect(result).toBeInstanceOf(Error)
        expect(database.prepare('SELECT status FROM extension_invocations').all()).toEqual([{ status: 'failed' }])
      }
    }
    finally {
      await service.dispose()
      await runtime.dispose()
      host.close(new Error('closed'))
      peer.close(new Error('closed'))
      database.close()
      vi.useRealTimers()
    }
  })

  it('runs all sixteen automatic actions alongside a tool within the host quota and gives each its execution deadline', async () => {
    vi.useFakeTimers()
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const descriptor: ExtensionAgentDescriptor = {
      id: 'tests.actions',
      name: 'Actions',
      revision: 'package',
      configurationRevision: 'config',
      agent: {
        instructions: '',
        tools: [{ id: 'tests.actions.tool', title: 'Tool', description: 'Fixture', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
        actions: Array.from({ length: 16 }, (_, index) => ({ id: `tests.actions.action${index}`, title: `Action ${index}`, triggers: ['task:input:committed'] })),
      },
    }
    createConversationRepository(database).create({ id: 'task', branchId: 'branch', title: null, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: new Date().toISOString() })
    const accepted: ExtensionAgentInvocation[] = []
    let active = 0
    let peak = 0
    const firstBatch = deferred<void>()
    const rpc: RuntimeRpcPeerContract = {
      notify() {},
      close() {},
      onRequest: () => () => {},
      onNotification: () => () => {},
      request: async (method, input, _timeout, signal) => {
        if (method === extensionAgentRpc.list)
          return [descriptor]
        if (active >= 4)
          throw new Error('EXTENSION_REQUEST_LIMIT')
        accepted.push(input as ExtensionAgentInvocation)
        active++
        peak = Math.max(peak, active)
        if (accepted.length === 4)
          firstBatch.resolve()
        try {
          await new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout>
            const cancel = () => {
              clearTimeout(timer)
              reject(signal?.reason)
            }
            timer = setTimeout(() => {
              signal?.removeEventListener('abort', cancel)
              resolve()
            }, 90000)
            signal?.addEventListener('abort', cancel, { once: true })
          })
          return { status: 'completed' }
        }
        finally { active-- }
      },
    }
    const runtime = new ExtensionAgentRuntime({ rpc, createHandlers: () => ({ 'task.get': async () => null, 'task.messages': async () => [], 'task.rename': async () => null, 'models.generateText': async () => null }) })
    const service = new ExtensionActionService({ runtime, repository: createExtensionInvocationRepository(database), capture: () => ({ branchId: 'branch', sourceMessageId: null }) })
    const errors: string[] = []
    service.onDidFail(event => errors.push(event.errorCode))
    try {
      const tool = runtime.invoke(descriptor, { tool: 'tests.actions.tool', input: {} }, { conversationId: 'task', runId: 'run' }, new AbortController().signal)
      service.dispatch({ type: 'task:input:committed', data: { conversationId: 'task', branchId: 'branch', runId: 'run', messageId: 'message', commitId: 'commit' } })
      await firstBatch.promise
      expect(accepted.filter(input => 'action' in input)).toHaveLength(3)
      for (let batch = 1; batch <= 5; batch++) {
        await vi.advanceTimersByTimeAsync(90000)
        expect(database.prepare('SELECT id FROM extension_invocations WHERE status = \'completed\'').all()).toHaveLength(Math.min(16, batch * 4 - 1))
      }
      await tool
      expect(peak).toBe(4)
      expect(active).toBe(0)
      expect(accepted.filter(input => 'action' in input).map(input => input.action)).toEqual(descriptor.agent.actions.map(action => action.id))
      expect(errors).toEqual([])
      expect(runtime.snapshot.activeInvocations).toEqual([])
    }
    finally {
      await service.dispose()
      await runtime.dispose()
      database.close()
      vi.useRealTimers()
    }
  })
})
