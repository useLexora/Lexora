import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionServicePorts } from '../ExtensionService'
import { rm } from 'node:fs/promises'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it } from 'vitest'
import { EXTENSION_API_VERSION } from '../../../shared/extensions/extensionManifest'
import { ExtensionService } from '../ExtensionService'
import { createStore, manifest, reviewPackage } from './fixtures'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function fixture(confirmBatch: NonNullable<NonNullable<ExtensionServicePorts['taskCleanup']>['confirmBatch']> | null = async () => true) {
  const { root, store } = await createStore()
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const definition = manifest({ apiVersion: EXTENSION_API_VERSION, permissions: { legacyTaskCleanup: true }, contributes: {
    commands: [{ id: 'tests.reader.cleanup', title: 'Cleanup' }],
    menus: [{ id: 'tests.reader.action', command: 'tests.reader.cleanup', target: 'extension.actions' }],
  } })
  await store.install((await reviewPackage(root, store, definition)).token)
  await store.install((await reviewPackage(root, store, manifest({ id: 'tests.peer', contributes: { commands: [{ id: 'tests.peer.noop', title: 'Peer' }] } }))).token)
  let broker!: (method: string, params: unknown) => Promise<JsonValue>
  const deleted: { conversationId: string, expectedRevision: number }[] = []
  let hostGeneration = 0
  const progressMessages: { extensionId: string, generation: number, params: Record<string, JsonValue> }[] = []
  let onProgress = async (_params: Record<string, JsonValue>) => {}
  let capturedToken: string | null = null
  let onCommand = async (params: Record<string, JsonValue>): Promise<JsonValue> => {
    capturedToken = typeof params.cleanupToken === 'string' ? params.cleanupToken : null
    if (capturedToken)
      await broker('taskCleanup.run', { token: capturedToken })
    return null
  }
  const service = new ExtensionService(store, {
    createHost: (pkg, call) => {
      const generation = ++hostGeneration
      if (pkg.manifest.id === definition.id)
        broker = call
      return { call: async (method, params) => {
        if (method === 'activate')
          return { commands: pkg.manifest.contributes.commands.map(item => item.id) }
        if (method === 'command')
          return pkg.manifest.id === definition.id ? onCommand(params as Record<string, JsonValue>) : null
        if (method === 'taskCleanup.progress') {
          const input = params as Record<string, JsonValue>
          progressMessages.push({ extensionId: pkg.manifest.id, generation, params: input })
          await onProgress(input)
        }
        return null
      }, dispose: async () => {}, devtools: () => {} }
    },
    createView: () => { throw new Error('NO_VIEW') },
    workbench: async () => null,
    readText: async () => '',
    get: async () => new Response(''),
    taskCleanup: {
      list: async () => ({ items: [{ conversationId: 'legacy', expectedRevision: 8, title: null, removedAt: '2026-01-01', estimatedBytes: null, canDelete: true, blockedReason: null }], nextCursor: null }),
      delete: async (input) => {
        deleted.push(input)
        return { status: 'deleted' }
      },
      confirmDelete: async () => { throw new Error('NO_VIEW') },
      ...(confirmBatch ? { confirmBatch } : {}),
    },
  })
  disposers.push(() => service.dispose())
  await service.restart(definition.id)
  await service.execute(definition.id, 'tests.reader.cleanup', null)
  return { service, deleted, progressMessages, onProgress: (handler: typeof onProgress) => {
    onProgress = handler
  }, broker: (method: string, params: unknown) => broker(method, params), token: () => capturedToken, onCommand: (handler: typeof onCommand) => {
    onCommand = handler
  }, run: (trusted = true, menu = 'tests.reader.action') => service.executeMenu(definition.id, menu, { target: 'extension.actions', resource: null }, trusted) }
}

it('accepts a main-only command, confirms once and returns host-owned per-item results', async () => {
  const counts: number[] = []
  const f = await fixture(async (count) => {
    counts.push(count)
    return true
  })
  expect(await f.run()).toMatchObject({ taskCleanup: { status: 'completed', results: [{ conversationId: 'legacy', expectedRevision: 8, status: 'deleted' }], summary: { phase: 'completed', total: 1, processed: 1, deleted: 1, pending: 0 } } })
  expect(counts).toEqual([1])
  expect(f.deleted).toEqual([{ conversationId: 'legacy', expectedRevision: 8 }])
  await expect(f.broker('taskCleanup.run', { token: f.token() })).rejects.toThrow('EXTENSION_METHOD_DENIED')
})

it('never grants cleanup to background, generic commands, slash, view self-calls or untrusted menu origins', async () => {
  const f = await fixture()
  await expect(f.broker('taskCleanup.run', { token: '00000000-0000-4000-8000-000000000001' })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await f.service.execute('tests.reader', 'tests.reader.cleanup', null)
  expect(f.token()).toBeNull()
  await f.run(false)
  expect(f.token()).toBeNull()
  await expect(f.service.executeSlash('tests.reader', 'tests.reader.cleanup', '')).rejects.toThrow('EXTENSION_COMMAND_UNAVAILABLE')
  await expect(f.broker('commands.execute', { command: 'tests.reader.cleanup', arguments: null })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(f.run(true, 'tests.other.action')).rejects.toThrow('EXTENSION_COMMAND_UNAVAILABLE')
  expect(f.deleted).toEqual([])
})

it('executes ordinary actions without opening a view and ignores forged cleanup feedback', async () => {
  const f = await fixture()
  let executed = false
  f.onCommand(async () => {
    executed = true
    return { taskCleanup: { status: 'completed', results: [{ conversationId: 'invented', expectedRevision: 99, status: 'deleted' }] } }
  })
  expect(await f.run()).toBeNull()
  expect(executed).toBe(true)
  expect(f.deleted).toEqual([])
})

it('consumes cancellation and rejects reuse while the command is still running', async () => {
  const f = await fixture(async () => false)
  f.onCommand(async (params) => {
    const input = { token: params.cleanupToken }
    expect(await f.broker('taskCleanup.run', input)).toMatchObject({ status: 'cancelled', results: [], summary: { phase: 'cancelled', total: 1, processed: 0 } })
    await expect(f.broker('taskCleanup.run', input)).rejects.toThrow('EXTENSION_METHOD_DENIED')
    return null
  })
  expect(await f.run()).toMatchObject({ taskCleanup: { status: 'cancelled', results: [], summary: { phase: 'cancelled', total: 1, processed: 0 } } })
  expect(f.deleted).toEqual([])
})

it('revokes confirmation when the plugin is disabled and hides disposed commands', async () => {
  const answer = deferred<boolean>()
  const started = deferred<void>()
  const f = await fixture(async () => {
    started.resolve()
    return answer.promise
  })
  const result = f.run()
  const rejected = expect(result).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await started.promise
  await f.service.enable('tests.reader', false)
  answer.resolve(true)
  await rejected
  expect(f.deleted).toEqual([])
  expect((await f.service.list())[0]?.registeredCommands).toEqual([])
  const second = await fixture()
  await second.broker('commands.changed', { commands: [] })
  expect((await second.service.list())[0]?.registeredCommands).toEqual([])
  await expect(second.run()).rejects.toThrow('EXTENSION_COMMAND_UNAVAILABLE')
})

it('publishes host confirmation and durable summaries independently of plugin return values', async () => {
  const f = await fixture(null)
  const started = deferred<void>()
  const subscription = f.service.onDidChange((change) => {
    if (change.kind === 'task-cleanup')
      started.resolve()
  })
  const result = f.run()
  await started.promise
  const operation = f.service.taskCleanupConfirmations()[0]!
  expect(operation).toEqual({ id: expect.any(String), total: 1, skipped: 0, extensionId: 'tests.reader' })
  expect((await f.service.list())[0]).not.toHaveProperty('taskCleanup')
  expect(f.deleted).toEqual([])
  await expect(f.service.confirmTaskCleanup('tests.reader', 'old-operation', true)).rejects.toThrow('EXTENSION_TASK_CLEANUP_EXPIRED')
  await f.service.confirmTaskCleanup('tests.reader', operation.id, true)
  expect(await result).toMatchObject({ taskCleanup: { summary: { phase: 'completed', processed: 1, total: 1, deleted: 1, pending: 0 } } })
  expect(f.service.taskCleanupConfirmations()).toEqual([])
  subscription.dispose()
})

it.each(['disable', 'dispose', 'reset'] as const)('releases deferred host confirmation on %s with no late approval', async (action) => {
  const f = await fixture(null)
  const started = deferred<void>()
  const subscription = f.service.onDidChange((change) => {
    if (change.kind === 'task-cleanup')
      started.resolve()
  })
  const run = f.run()
  const rejected = expect(run).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await started.promise
  const operation = f.service.taskCleanupConfirmations()[0]!
  if (action === 'disable')
    await f.service.enable('tests.reader', false)
  else if (action === 'dispose')
    await f.service.dispose()
  else await f.service.resetHosts()
  await rejected
  expect(f.deleted).toEqual([])
  await expect(f.service.confirmTaskCleanup('tests.reader', operation.id, true)).rejects.toThrow('EXTENSION_TASK_CLEANUP_EXPIRED')
  expect(f.service.taskCleanupConfirmations()).toEqual([])
  subscription.dispose()
})

it('does not mint a cleanup token when the window hides during command activation', async () => {
  const f = await fixture(null)
  const run = f.run()
  f.service.cancelUnconfirmedTaskCleanup()
  expect(await run).toBeNull()
  expect(f.token()).toBeNull()
  expect(f.deleted).toEqual([])
  expect(f.service.taskCleanupConfirmations()).toEqual([])
})

it('revokes an unused token on hide before a delayed plugin starts cleanup', async () => {
  const f = await fixture(null)
  const entered = deferred<void>()
  const resume = deferred<void>()
  f.onCommand(async (params) => {
    expect(typeof params.cleanupToken).toBe('string')
    entered.resolve()
    await resume.promise
    await expect(f.broker('taskCleanup.run', { token: params.cleanupToken })).rejects.toThrow('EXTENSION_METHOD_DENIED')
    return null
  })
  const run = f.run()
  await entered.promise
  f.service.cancelUnconfirmedTaskCleanup()
  resume.resolve()
  expect(await run).toBeNull()
  expect(f.deleted).toEqual([])
  expect(f.service.taskCleanupConfirmations()).toEqual([])
})

it('returns a cancelled host result on hide and accepts a fresh explicitly confirmed invocation', async () => {
  const f = await fixture(null)
  let started = deferred<void>()
  const subscription = f.service.onDidChange((change) => {
    if (change.kind === 'task-cleanup')
      started.resolve()
  })
  const first = f.run()
  await started.promise
  const previous = f.service.taskCleanupConfirmations()[0]!
  expect(previous.total).toBe(1)
  f.service.cancelUnconfirmedTaskCleanup()
  expect(await first).toMatchObject({ taskCleanup: { status: 'cancelled', results: [], summary: { phase: 'cancelled', processed: 0 } } })
  expect(f.service.taskCleanupConfirmations()).toEqual([])
  expect(f.deleted).toEqual([])
  started = deferred<void>()
  const second = f.run()
  await started.promise
  const current = f.service.taskCleanupConfirmations()[0]!
  expect(current.id).not.toBe(previous.id)
  await expect(f.service.confirmTaskCleanup('tests.reader', previous.id, true)).rejects.toThrow('EXTENSION_TASK_CLEANUP_EXPIRED')
  await f.service.confirmTaskCleanup('tests.reader', current.id, true)
  await second
  expect(f.deleted).toEqual([{ conversationId: 'legacy', expectedRevision: 8 }])
  subscription.dispose()
})

it('invalidates a confirmation if the plugin stops awaiting its invocation', async () => {
  const f = await fixture(null)
  const started = deferred<void>()
  const subscription = f.service.onDidChange((change) => {
    if (change.kind === 'task-cleanup')
      started.resolve()
  })
  let cleanupResult: Promise<JsonValue> | undefined
  f.onCommand(async (params) => {
    cleanupResult = f.broker('taskCleanup.run', { token: params.cleanupToken })
    void cleanupResult.catch(() => {})
    await started.promise
    return null
  })
  await f.run()
  await expect(cleanupResult).resolves.toMatchObject({ summary: { phase: 'failed', errorCode: 'EXTENSION_TASK_CLEANUP_EXPIRED', processed: 0, deleted: 0 } })
  expect(f.service.taskCleanupConfirmations()).toEqual([])
  expect(f.deleted).toEqual([])
  subscription.dispose()
})

it('pushes bounded progress only to the initiating token and generation', async () => {
  const f = await fixture()
  await f.service.execute('tests.peer', 'tests.peer.noop', null)
  const entered = deferred<void>()
  const release = deferred<void>()
  f.onProgress(async (params) => {
    if ((params.progress as Record<string, JsonValue>).phase === 'scanning') {
      entered.resolve()
      await release.promise
    }
  })
  const run = f.run()
  await entered.promise
  expect(f.progressMessages).toHaveLength(1)
  expect(f.deleted).toEqual([])
  release.resolve()
  const result = await run as { taskCleanup: { summary: JsonValue } }
  expect(f.progressMessages.at(-1)!.params.progress).toEqual(result.taskCleanup.summary)
  expect(new Set(f.progressMessages.map(item => item.generation)).size).toBe(1)
  const previous = f.progressMessages[0]!
  for (const message of f.progressMessages) {
    expect(message.extensionId).toBe('tests.reader')
    expect(message.params.token).toBe(f.token())
    expect(Object.keys(message.params.progress as object).sort()).toEqual(['deleted', 'errorCode', 'failed', 'pending', 'phase', 'processed', 'skipped', 'total'])
  }
  const length = f.progressMessages.length
  await f.service.restart('tests.reader')
  await expect(f.broker('taskCleanup.run', { token: previous.params.token })).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await f.service.execute('tests.reader', 'tests.reader.cleanup', null)
  await expect(f.broker('taskCleanup.run', { token: previous.params.token })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  expect(f.progressMessages).toHaveLength(length)
  await f.run()
  expect(f.progressMessages[length]!.generation).not.toBe(previous.generation)
  expect(f.progressMessages[length]!.params.token).not.toBe(previous.params.token)
})

it('does not submit deletion after progress delivery becomes unavailable', async () => {
  const f = await fixture()
  f.onProgress(async () => {
    throw new Error('EXTENSION_HOST_STOPPED')
  })
  expect(await f.run()).toMatchObject({ taskCleanup: { results: [], summary: { phase: 'failed', total: null, processed: 0, errorCode: 'EXTENSION_TASK_CLEANUP_UNAVAILABLE' } } })
  expect(f.progressMessages).toHaveLength(1)
  expect(f.deleted).toEqual([])
  expect(f.service.taskCleanupConfirmations()).toEqual([])
})
