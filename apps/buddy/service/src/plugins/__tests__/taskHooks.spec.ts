import type { ExtensionAgentDescriptor } from '../../../../shared/extensions/extensionAgent'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { extensionActionSchema } from '../../../../shared/extensions/extensionAgent'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createExtensionInvocationRepository } from '../../storage/extensionInvocationRepository'
import { ExtensionActionService } from '../ExtensionActionService'

const input = { type: 'task:input:committed' as const, data: { conversationId: 'task', branchId: 'branch', runId: 'run', messageId: 'message', commitId: 'commit' } }
const before = { type: 'task:run:before' as const, data: { conversationId: 'task', branchId: 'branch', runId: 'run', messageId: 'message' } }
const descriptor: ExtensionAgentDescriptor = { id: 'tests.hooks', name: 'Hooks', revision: 'package', configurationRevision: 'config', agent: { tools: [], instructions: '', actions: [{ id: 'tests.hooks.title', title: 'Title', triggers: ['task:created', 'task:reply:started'] }, { id: 'tests.hooks.prepare', title: 'Prepare', triggers: ['task:run:before'], execution: 'blocking' }] } }

function fixture(invoke: (cause: string, signal: AbortSignal) => Promise<void>, descriptors: () => Promise<ExtensionAgentDescriptor[]> = async () => [descriptor]) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  createConversationRepository(database).create({ id: 'task', branchId: 'branch', title: 'Fallback', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: new Date().toISOString() })
  const service = new ExtensionActionService({
    runtime: { descriptors, invoke: async (_descriptor, request, _scope, signal) => {
      if ('action' in request)
        await invoke(request.cause.type, signal)
      return { status: 'completed' }
    } },
    repository: createExtensionInvocationRepository(database),
    capture: () => ({ branchId: 'branch', sourceMessageId: null }),
  })
  return { service, database, dispose: async () => {
    await service.dispose()
    database.close()
  } }
}

describe('task lifecycle hooks', () => {
  it('orders creation before reply for the same action without waiting for background completion', async () => {
    const catalog = deferred<ExtensionAgentDescriptor[]>()
    const admission = deferred<void>()
    const started = deferred<void>()
    const calls: string[] = []
    const f = fixture(async (cause) => {
      calls.push(cause)
      if (cause === 'task:created') {
        started.resolve()
        await admission.promise
      }
    }, () => catalog.promise)
    try {
      f.service.dispatch(input, true)
      f.service.replyStarted('run')
      f.service.replyStarted('run')
      catalog.resolve([descriptor])
      await started.promise
      expect(calls).toEqual(['task:created'])
      admission.resolve()
      await vi.waitFor(() => expect(calls).toEqual(['task:created', 'task:reply:started']))
      await vi.waitFor(() => expect(f.database.prepare('SELECT COUNT(*) AS count FROM extension_invocations WHERE status = \'completed\'').get()).toEqual({ count: 2 }))
      expect(f.database.prepare('SELECT trigger, status FROM extension_invocations ORDER BY rowid').all()).toEqual([{ trigger: 'task:created', status: 'completed' }, { trigger: 'task:reply:started', status: 'completed' }])
    }
    finally {
      admission.resolve()
      await f.dispose()
    }
  })

  it('captures contributors at input and never gives a newly installed plugin an earlier task creation', async () => {
    let plugins: ExtensionAgentDescriptor[] = []
    const calls: string[] = []
    const f = fixture(async (cause) => {
      calls.push(cause)
    }, async () => [...plugins])
    try {
      f.service.dispatch(input, true)
      plugins = [descriptor]
      await f.service.beforeRun(before, new AbortController().signal)
      f.service.replyStarted('run')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls).toEqual([])
      expect(f.database.prepare('SELECT id FROM extension_invocations').all()).toEqual([])
    }
    finally { await f.dispose() }
  })

  it('waits for pre-run hooks and stops a failed preparation', async () => {
    const gate = deferred<void>()
    const started = deferred<void>()
    const calls: string[] = []
    let fail = false
    const f = fixture(async (cause) => {
      if (cause === 'task:run:before') {
        started.resolve()
        await gate.promise
        if (fail)
          throw new Error('EXTENSION_PREPARATION_FAILED')
      }
      calls.push(cause)
    })
    try {
      f.service.dispatch(input)
      const launch = f.service.beforeRun(before, new AbortController().signal).then(() => {
        calls.push('main')
      })
      await started.promise
      expect(calls).toEqual([])
      gate.resolve()
      await launch
      expect(calls).toEqual(['task:run:before', 'main'])
      fail = true
      await expect(f.service.beforeRun(before, new AbortController().signal)).rejects.toThrow('EXTENSION_PREPARATION_FAILED')
      expect(f.database.prepare('SELECT status FROM extension_invocations ORDER BY rowid').all()).toEqual([{ status: 'completed' }, { status: 'failed' }])
    }
    finally {
      gate.resolve()
      await f.dispose()
    }
  })

  it('runs blocking contributors sequentially in stable plugin and action order', async () => {
    const calls: string[] = []
    const plugins = ['tests.z', 'tests.a'].map(id => ({
      ...descriptor,
      id,
      agent: { ...descriptor.agent, actions: ['z', 'a'].map(suffix => ({ id: `${id}.${suffix}`, title: suffix, triggers: ['task:run:before' as const], execution: 'blocking' as const })) },
    }))
    const f = fixture(async () => {}, async () => plugins)
    try {
      await f.service.beforeRun(before, new AbortController().signal)
      calls.push(...f.database.prepare('SELECT action_id FROM extension_invocations ORDER BY rowid').all().map(row => String(row.action_id)))
      expect(calls).toEqual(['tests.a.a', 'tests.a.z', 'tests.z.a', 'tests.z.z'])
    }
    finally { await f.dispose() }
  })

  it('bounds the entire pre-run phase and revokes timed-out invocations', async () => {
    vi.useFakeTimers()
    const f = fixture(async (_cause, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    try {
      const pending = f.service.beforeRun(before, new AbortController().signal)
      const checked = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(10000)
      await checked
      expect(f.database.prepare('SELECT status FROM extension_invocations').all()).toEqual([{ status: 'cancelled' }])
    }
    finally {
      await f.dispose()
      vi.useRealTimers()
    }
  })

  it('includes contributor lookup in the deadline and prevents late execution after expiry', async () => {
    vi.useFakeTimers()
    const catalog = deferred<ExtensionAgentDescriptor[]>()
    const calls: string[] = []
    const f = fixture(async (cause) => {
      calls.push(cause)
    }, () => catalog.promise)
    try {
      f.service.dispatch(input)
      const pending = f.service.beforeRun(before, new AbortController().signal)
      const checked = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(10000)
      await checked
      catalog.resolve([descriptor])
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual([])
      expect(f.database.prepare('SELECT id FROM extension_invocations').all()).toEqual([])
    }
    finally {
      catalog.resolve([])
      await f.dispose()
      vi.useRealTimers()
    }
  })

  it('only permits explicitly blocking pre-run declarations', () => {
    expect(extensionActionSchema.safeParse({ id: 'tests.prepare', title: 'Prepare', triggers: ['task:run:before'], execution: 'blocking' }).success).toBe(true)
    for (const trigger of ['task:created', 'task:reply:started', 'task:turn:completed', 'user'])
      expect(extensionActionSchema.safeParse({ id: 'tests.prepare', title: 'Prepare', triggers: [trigger], execution: 'blocking' }).success).toBe(false)
  })
})
