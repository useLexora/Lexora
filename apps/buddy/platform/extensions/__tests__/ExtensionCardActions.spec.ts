import type { ExtensionTaskCleanupPreview } from '../../../shared/extensions/extensionTaskCleanup'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { EXTENSION_API_VERSION } from '../../../shared/extensions/extensionManifest'
import { ExtensionService } from '../ExtensionService'
import { createStore, manifest, reviewPackage } from './fixtures'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function fixture(confirm: (preview: ExtensionTaskCleanupPreview, signal: AbortSignal) => Promise<JsonValue> = async () => true) {
  const { root, store } = await createStore()
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const definition = manifest({ apiVersion: EXTENSION_API_VERSION, permissions: { legacyTaskCleanup: true }, contributes: {
    commands: [{ id: 'tests.reader.cleanup', title: 'Cleanup' }],
    views: [{ id: 'tests.reader.page', title: 'Cleanup', entry: 'view.js', location: 'page', resource: 'none' }],
    menus: [{ id: 'tests.reader.action', command: 'tests.reader.cleanup', target: 'extension.actions' }],
  } })
  await store.install((await reviewPackage(root, store, definition)).token)
  await store.install((await reviewPackage(root, store, manifest({ id: 'tests.peer', contributes: {
    commands: [{ id: 'tests.peer.noop', title: 'Peer' }],
    views: [{ id: 'tests.peer.page', title: 'Peer', entry: 'view.js', location: 'page', resource: 'none' }],
  } }))).token)
  let broker!: (method: string, params: unknown) => Promise<JsonValue>
  const deleted: { conversationId: string, expectedRevision: number }[] = []
  let hostGeneration = 0
  const progressMessages: { extensionId: string, generation: number, params: Record<string, JsonValue> }[] = []
  const cancelledTokens: JsonValue[] = []
  let onProgress = async (_params: Record<string, JsonValue>, _signal: AbortSignal) => {}
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
      return { call: async (method, params, signal) => {
        if (method === 'activate')
          return { commands: pkg.manifest.contributes.commands.map(item => item.id) }
        if (method === 'command')
          return pkg.manifest.id === definition.id ? onCommand(params as Record<string, JsonValue>) : null
        if (method === 'taskCleanup.confirm')
          return confirm((params as unknown as { preview: ExtensionTaskCleanupPreview }).preview, signal!)
        if (method === 'taskCleanup.cancel')
          cancelledTokens.push((params as Record<string, JsonValue>).token!)
        if (method === 'taskCleanup.progress') {
          const input = params as Record<string, JsonValue>
          progressMessages.push({ extensionId: pkg.manifest.id, generation, params: input })
          await onProgress(input, signal!)
        }
        return null
      }, dispose: async () => {}, devtools: () => {} }
    },
    createView: () => ({ token: randomUUID(), url: 'lexora-extension://fixture/__view.html', dispose: () => {} }),
    workbench: async () => null,
    readText: async () => '',
    get: async () => new Response(''),
    taskCleanup: {
      list: async () => ({ items: [{ conversationId: 'legacy', expectedRevision: 8, title: null, removedAt: '2026-01-01', estimatedBytes: null, canDelete: true, blockedReason: null }], nextCursor: null }),
      delete: async (input) => {
        deleted.push(input)
        return { status: 'deleted' }
      },
    },
  })
  disposers.push(() => service.dispose())
  await service.restart(definition.id)
  await service.execute(definition.id, 'tests.reader.cleanup', null)
  return { service, deleted, progressMessages, cancelledTokens, onProgress: (handler: typeof onProgress) => {
    onProgress = handler
  }, broker: (method: string, params: unknown) => broker(method, params), token: () => capturedToken, onCommand: (handler: typeof onCommand) => {
    onCommand = handler
  }, run: (trusted = true, menu = 'tests.reader.action') => service.executeMenu(definition.id, menu, { target: 'extension.actions', resource: null }, trusted) }
}

it('accepts a main-only command, confirms once and returns host-owned per-item results', async () => {
  const previews: ExtensionTaskCleanupPreview[] = []
  const f = await fixture(async (preview) => {
    previews.push(preview)
    return true
  })
  expect(await f.run()).toMatchObject({ taskCleanup: { status: 'completed', results: [{ conversationId: 'legacy', expectedRevision: 8, status: 'deleted' }], summary: { phase: 'completed', total: 1, processed: 1, deleted: 1, pending: 0 } } })
  expect(previews).toEqual([{ total: 1, skipped: 0 }])
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
  await f.broker('commands.changed', { commands: [] })
  expect((await f.service.list())[0]?.registeredCommands).toEqual([])
  await expect(f.run()).rejects.toThrow('EXTENSION_COMMAND_UNAVAILABLE')
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

it.each(['disable', 'dispose', 'reset'] as const)('releases plugin confirmation on %s with no late approval', async (action) => {
  const answer = deferred<boolean>()
  const started = deferred<AbortSignal>()
  const f = await fixture(async (_preview, signal) => {
    started.resolve(signal)
    return answer.promise
  })
  const run = f.run()
  const rejected = expect(run).rejects.toThrow('EXTENSION_HOST_STOPPED')
  const signal = await started.promise
  if (action === 'disable') {
    await f.service.enable('tests.reader', false)
    expect((await f.service.list())[0]?.registeredCommands).toEqual([])
  }
  else if (action === 'dispose') {
    await f.service.dispose()
  }
  else {
    await f.service.resetHosts()
  }
  await rejected
  expect(signal.aborted).toBe(true)
  expect(f.cancelledTokens).toEqual([f.token()])
  answer.resolve(true)
  await Promise.resolve()
  expect(f.deleted).toEqual([])
})

it('rejects a truthy non-boolean confirmation response', async () => {
  const f = await fixture(async () => 'true')
  expect(await f.run()).toMatchObject({ taskCleanup: { results: [], summary: { phase: 'failed', processed: 0 } } })
  expect(f.deleted).toEqual([])
})

it('fails closed when confirmation throws', async () => {
  const f = await fixture(async () => {
    throw new Error('EXTENSION_OPERATION_FAILED')
  })
  expect(await f.run()).toMatchObject({ taskCleanup: { results: [], summary: { phase: 'failed', processed: 0 } } })
  expect(f.deleted).toEqual([])
})

it('does not mint a cleanup token when the window hides during command activation', async () => {
  const f = await fixture()
  const run = f.run()
  f.service.cancelUnconfirmedTaskCleanup()
  expect(await run).toBeNull()
  expect(f.token()).toBeNull()
  expect(f.deleted).toEqual([])
})

it.each(['hide', 'close-view', 'close-other-view'] as const)('scopes unused token revocation on %s before a delayed plugin starts cleanup', async (action) => {
  const f = await fixture()
  const extensionId = action === 'close-other-view' ? 'tests.peer' : 'tests.reader'
  const view = await f.service.openView({ viewId: randomUUID(), extensionId, viewType: `${extensionId}.page`, resource: null, state: null, stateVersion: 1 })
  const entered = deferred<void>()
  const resume = deferred<void>()
  f.onCommand(async (params) => {
    expect(typeof params.cleanupToken).toBe('string')
    entered.resolve()
    await resume.promise
    const cleanup = f.broker('taskCleanup.run', { token: params.cleanupToken })
    if (action === 'close-other-view')
      await expect(cleanup).resolves.toMatchObject({ summary: { phase: 'completed', deleted: 1 } })
    else await expect(cleanup).rejects.toThrow('EXTENSION_METHOD_DENIED')
    return null
  })
  const run = f.run()
  await entered.promise
  if (action === 'hide')
    f.service.cancelUnconfirmedTaskCleanup()
  else f.service.closeView(view.id, view.generation, view.token)
  resume.resolve()
  if (action === 'close-other-view')
    expect(await run).toMatchObject({ taskCleanup: { summary: { phase: 'completed', deleted: 1 } } })
  else expect(await run).toBeNull()
  expect(f.deleted).toEqual(action === 'close-other-view' ? [{ conversationId: 'legacy', expectedRevision: 8 }] : [])
})

it.each(['hide', 'close-view'] as const)('cancels on %s and accepts a fresh invocation without reviving late confirmation', async (action) => {
  const started = deferred<AbortSignal>()
  const answer = deferred<boolean>()
  let calls = 0
  const f = await fixture(async (_preview, signal) => {
    if (++calls > 1)
      return true
    started.resolve(signal)
    return answer.promise
  })
  const view = await f.service.openView({ viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.page', resource: null, state: null, stateVersion: 1 })
  const first = f.run()
  const signal = await started.promise
  const previous = f.token()
  if (action === 'hide')
    f.service.cancelUnconfirmedTaskCleanup()
  else f.service.closeView(view.id, view.generation, view.token)
  expect(await first).toMatchObject({ taskCleanup: { status: 'cancelled', results: [], summary: { phase: 'cancelled', processed: 0 } } })
  expect(signal.aborted).toBe(true)
  expect(f.cancelledTokens).toEqual([previous])
  expect(f.deleted).toEqual([])
  answer.resolve(true)
  await expect(f.broker('taskCleanup.run', { token: previous })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await f.run()
  expect(f.token()).not.toBe(previous)
  expect(f.deleted).toEqual([{ conversationId: 'legacy', expectedRevision: 8 }])
})

it('invalidates a confirmation if the plugin stops awaiting its invocation', async () => {
  const started = deferred<AbortSignal>()
  const answer = deferred<boolean>()
  const f = await fixture(async (_preview, signal) => {
    started.resolve(signal)
    return answer.promise
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
  expect((await started.promise).aborted).toBe(true)
  answer.resolve(true)
  expect(f.deleted).toEqual([])
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
})

it('does not impose the progress ACK timeout on confirmation', async () => {
  const started = deferred<AbortSignal>()
  const answer = deferred<boolean>()
  const f = await fixture(async (_preview, signal) => {
    started.resolve(signal)
    return answer.promise
  })
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(), ms)
    return abort.signal
  })
  try {
    const run = f.run()
    const signal = await started.promise
    await vi.advanceTimersByTimeAsync(6000)
    expect(signal.aborted).toBe(false)
    expect(f.deleted).toEqual([])
    answer.resolve(true)
    expect(await run).toMatchObject({ taskCleanup: { summary: { phase: 'completed', deleted: 1 } } })
  }
  finally {
    timeout.mockRestore()
    vi.useRealTimers()
  }
})

it('stops before deletion when a progress ACK exceeds five seconds', async () => {
  const entered = deferred<void>()
  const f = await fixture()
  f.onProgress(async (_params, signal) => {
    entered.resolve()
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('EXTENSION_REQUEST_TIMEOUT')), { once: true })
    })
  })
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(), ms)
    return abort.signal
  })
  try {
    const run = f.run()
    await entered.promise
    expect(timeout).toHaveBeenCalledWith(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await run).toMatchObject({ taskCleanup: { results: [], summary: { phase: 'failed', errorCode: 'EXTENSION_TASK_CLEANUP_UNAVAILABLE' } } })
    expect(f.deleted).toEqual([])
  }
  finally {
    timeout.mockRestore()
    vi.useRealTimers()
  }
})
