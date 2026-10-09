import type { ExtensionConditionContext } from '../../../shared/extensions/extensionConditionContext'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionHost, ExtensionServicePorts } from '../ExtensionService'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { deferred } from '@buddy-tests/deferred'
import { expect, it, vi } from 'vitest'
import { extensionConditionContextSchema } from '../../../shared/extensions/extensionConditionContext'
import { extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import { ExtensionConditionEvaluator } from '../ExtensionConditionEvaluator'
import { ExtensionConditions } from '../ExtensionConditions'
import { ExtensionService } from '../ExtensionService'
import { createStore, manifest, reviewPackage } from './fixtures'

const condition = 'tests.reader.available'
function definition() {
  return manifest({ apiVersion: 3, permissions: { agent: true, models: true, tasks: 'read' }, contributes: {
    conditions: [{ id: condition, inputs: ['configuration', 'form', 'runtime.models', 'runtime.task', 'workbench'] }],
    agent: { enabledWhen: { condition }, actions: [{ id: 'tests.reader.run', title: 'Run', triggers: ['user'] }] },
    settings: { items: [
      { id: 'tests.reader.enabled', key: 'enabled', group: 'settings.general.general', type: 'boolean', title: 'Enabled', default: true },
      { id: 'tests.reader.model', key: 'model', group: 'settings.general.general', type: 'model', title: 'Model', default: null, enabledWhen: { condition, params: { purpose: 'configure', nested: { supported: [true, null, 1] } } } },
    ] },
  } })
}
it('validates owned references, declared inputs, permissions and bounded parameters', () => {
  const valid = definition()
  expect(valid.contributes.agent?.enabledWhen).toEqual({ condition, params: {} })
  for (const conditions of [[], [{ id: 'another.plugin.available', inputs: [] }], [{ id: condition, inputs: ['configuration', 'configuration'] }]])
    expect(extensionManifestSchema.safeParse({ ...valid, contributes: { ...valid.contributes, conditions } }).success).toBe(false)
  for (const permissions of [{ ...valid.permissions, models: false }, { ...valid.permissions, tasks: 'none' }])
    expect(extensionManifestSchema.safeParse({ ...valid, permissions }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...valid, contributes: { ...valid.contributes, agent: { ...valid.contributes.agent, enabledWhen: { condition, params: { large: 'x'.repeat(17000) } } } } }).success).toBe(false)
})

it('refreshes saved configuration and scopes runtime rechecks to the invoking task without trusting the settings cache', async () => {
  const { store, root } = await createStore()
  const pkg = definition()
  await store.install((await reviewPackage(root, store, pkg)).token)
  const seen: ExtensionConditionContext[] = []
  const requests: unknown[] = []
  let invoked = 0
  const ports: ExtensionServicePorts = {
    createHost: () => ({ call: async (method, params): Promise<JsonValue> => {
      if (method === 'conditions.evaluate') {
        const context = extensionConditionContextSchema.parse((params as Record<string, JsonValue>).context)
        seen.push(context)
        return context.configuration.status === 'available' && context.configuration.values.enabled === true && context.scope.invocation.kind === 'settings'
      }
      if (method === 'agent.invoke') {
        invoked++
        return { status: 'completed' }
      }
      if (method === 'configuration.changed')
        return { ...(params as object), applied: true }
      return null
    }, dispose: async () => {}, devtools() {} }),
    createView: () => { throw new Error('unused') },
    workbench: async () => null,
    get: async () => new Response(''),
    readText: async () => '',
    conditionRuntime: async (input) => {
      requests.push(input)
      return { models: { status: 'available', revision: 'models-1', models: [], selection: null }, task: { status: 'no_context' } }
    },
  }
  const service = new ExtensionService(store, ports)
  try {
    const field = 'tests.reader.model'
    expect(await service.conditions.settings(pkg.id, [field], { enabled: false })).toEqual({ [field]: { status: 'ready', value: true } })
    expect(seen.at(-1)).toMatchObject({ version: 1, scope: { configuration: { kind: 'global' }, invocation: { kind: 'settings', groupId: 'settings.general.general' } }, configuration: { values: { enabled: true, model: null }, sources: { enabled: { kind: 'global' } } }, form: { values: { enabled: false, model: null }, dirtyKeys: ['enabled'] }, runtime: { task: { status: 'no_context' } } })
    await service.configure(pkg.id, { enabled: false })
    expect(await service.conditions.settings(pkg.id, [field])).toEqual({ [field]: { status: 'ready', value: false } })
    await service.configure(pkg.id, { enabled: true })
    const [descriptor] = await service.agentContributions()
    const result = await service.invokeAgent({ extensionId: pkg.id, revision: descriptor!.revision, configurationRevision: descriptor!.configurationRevision, invocationId: randomUUID(), action: 'tests.reader.run', cause: { type: 'user' }, context: { taskId: 'origin-task', runId: null } }, new AbortController().signal)
    expect(result).toEqual({ status: 'skipped' })
    expect(invoked).toBe(0)
    expect(seen.at(-1)).toMatchObject({ scope: { invocation: { kind: 'task', taskId: 'origin-task', runId: null } }, form: { status: 'no_context' } })
    expect(requests.at(-1)).toEqual({ models: true, task: true, taskId: 'origin-task', runId: null })
  }
  finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('rechecks an invalidated invocation condition once and cancels continued churn without executing stale actions', async () => {
  const { store, root } = await createStore()
  const pkg = definition()
  await store.install((await reviewPackage(root, store, pkg)).token)
  const pending: ReturnType<typeof deferred<JsonValue>>[] = []
  let invoked = 0
  let mode: 'wait' | 'ready' | 'fail' = 'wait'
  const service = new ExtensionService(store, {
    createHost: () => ({ call: async (method): Promise<JsonValue> => {
      if (method === 'conditions.evaluate') {
        if (mode === 'fail')
          throw new Error('Fixture condition failed')
        if (mode === 'ready')
          return true
        const result = deferred<JsonValue>()
        pending.push(result)
        return result.promise
      }
      if (method === 'agent.invoke') {
        invoked++
        return { status: 'completed' }
      }
      return null
    }, dispose: async () => {}, devtools() {} }),
    createView: () => { throw new Error('unused') },
    workbench: async () => null,
    get: async () => new Response(''),
    readText: async () => '',
  })
  const invoke = async () => {
    const [descriptor] = await service.agentContributions()
    return service.invokeAgent({ extensionId: pkg.id, revision: descriptor!.revision, configurationRevision: descriptor!.configurationRevision, invocationId: randomUUID(), action: 'tests.reader.run', cause: { type: 'user' }, context: { taskId: 'origin-task', runId: null } }, new AbortController().signal)
  }
  const invalidate = () => service.conditions.invalidate({ inputs: ['runtime.task'], taskId: 'origin-task' })
  try {
    const first = invoke()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    invalidate()
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[0]!.resolve(true)
    expect(invoked).toBe(0)
    pending[1]!.resolve(true)
    expect(await first).toEqual({ status: 'completed' })
    expect(invoked).toBe(1)

    const cancelled = expect(invoke()).rejects.toMatchObject({ code: 'EXTENSION_AGENT_CANCELLED' })
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    invalidate()
    await vi.waitFor(() => expect(pending).toHaveLength(4))
    invalidate()
    await cancelled
    pending[2]!.resolve(true)
    pending[3]!.resolve(true)
    expect(invoked).toBe(1)

    mode = 'fail'
    await expect(invoke()).rejects.toThrow('EXTENSION_CONDITION_UNAVAILABLE')
    expect(invoked).toBe(1)
    mode = 'ready'
    expect(await invoke()).toEqual({ status: 'completed' })
    expect(invoked).toBe(2)
  }
  finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

function evaluationFixture() {
  const engine = new ExtensionConditionEvaluator()
  const pending: ReturnType<typeof deferred<JsonValue>>[] = []
  const stopped = new AbortController()
  const host: ExtensionHost = { call: async (method) => {
    if (method !== 'conditions.evaluate')
      return null
    const value = deferred<JsonValue>()
    pending.push(value)
    return value.promise
  }, dispose: async () => {}, devtools() {} }
  const context = extensionConditionContextSchema.parse({ version: 1, scope: { key: 'scope', configuration: { kind: 'global' }, invocation: { kind: 'settings', moduleId: 'settings.general', groupId: 'settings.general.general' } }, target: { kind: 'setting', id: 'tests.reader.model' }, configuration: { status: 'available', revision: 'configuration-1', values: { enabled: true }, sources: { enabled: { kind: 'global' } } }, runtime: { models: { status: 'not_requested' }, task: { status: 'not_requested' } }, workbench: { status: 'not_requested' }, form: { status: 'not_requested' } })
  const input = { extensionId: 'tests.reader', definition: { id: condition, inputs: ['configuration' as const] }, reference: { condition, params: {} }, scopeKey: 'scope', cache: true, snapshot: async () => ({ generation: 'host-1', context, host, signal: stopped.signal }) }
  return { engine, pending, input, context, stopped }
}
it('shares identical pending reads, rejects invalidated results and isolates context revisions', async () => {
  const f = evaluationFixture()
  try {
    const first = f.engine.evaluate(f.input)
    const duplicate = f.engine.evaluate(f.input)
    await vi.waitFor(() => expect(f.pending).toHaveLength(1))
    f.pending[0]!.resolve({ value: true, reason: 'ready' })
    expect(await first).toEqual(await duplicate)
    expect(await f.engine.evaluate(f.input)).toEqual({ status: 'ready', value: true, reason: 'ready' })
    expect(f.pending).toHaveLength(1)
    f.engine.invalidate({ extensionId: 'tests.reader', condition, scopeKey: 'scope' })
    const stale = f.engine.evaluate(f.input)
    await vi.waitFor(() => expect(f.pending).toHaveLength(2))
    f.engine.invalidate({ extensionId: 'tests.reader', condition })
    expect(await stale).toEqual({ status: 'unavailable', value: false })
    f.pending[1]!.resolve(true)
    const fresh = f.engine.evaluate(f.input)
    await vi.waitFor(() => expect(f.pending).toHaveLength(3))
    f.pending[2]!.resolve(false)
    expect(await fresh).toEqual({ status: 'ready', value: false })
    f.context.configuration = { status: 'invalid' }
    const invalid = f.engine.evaluate(f.input)
    await vi.waitFor(() => expect(f.pending).toHaveLength(4))
    f.pending[3]!.resolve({ unexpected: true })
    expect(await invalid).toEqual({ status: 'unavailable', value: false })
  }
  finally { f.engine.dispose() }
})
it('releases hung snapshots on cancellation and fences host replacement', async () => {
  const f = evaluationFixture()
  const stop = new AbortController()
  const waiting = f.engine.evaluate({ ...f.input, signal: stop.signal, snapshot: () => new Promise(() => {}) })
  stop.abort()
  expect(await waiting).toEqual({ status: 'unavailable', value: false })
  const oldHost = f.engine.evaluate(f.input)
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  f.stopped.abort()
  expect(await oldHost).toEqual({ status: 'unavailable', value: false })
  f.pending[0]!.resolve(true)
  f.engine.dispose()
})

it('queues a legal 64-field batch within 32 slots and caches every result', async () => {
  vi.useFakeTimers()
  const { store, root } = await createStore()
  const pkg = manifest({ apiVersion: 3, contributes: {
    conditions: [{ id: condition, inputs: ['form'] }],
    settings: { items: Array.from({ length: 64 }, (_, index) => ({ id: `tests.reader.field${index}`, key: `field${index}`, title: `Field ${index}`, group: 'settings.general.general', type: 'string', default: '', enabledWhen: { condition } })) },
  } })
  await store.install((await reviewPackage(root, store, pkg)).token)
  const installed = store.installed[pkg.id]!.current
  let active = 0
  let peak = 0
  let evaluated = 0
  const host: ExtensionHost = {
    call: async (method) => {
      if (method !== 'conditions.evaluate')
        return null
      active++
      peak = Math.max(peak, active)
      evaluated++
      await new Promise(resolve => setTimeout(resolve, 4000))
      active--
      return true
    },
    dispose: async () => {},
    devtools() {},
  }
  const conditions = new ExtensionConditions({
    package: async () => installed,
    packages: () => [installed],
    configuration: async () => ({ values: {}, invalidKeys: [] }),
    activate: async () => ({ generation: 'host', host, signal: new AbortController().signal }),
    workbench: () => [],
  })
  try {
    const fields = pkg.contributes.settings.items.map(item => item.id)
    const result = conditions.settings(pkg.id, fields)
    await vi.advanceTimersByTimeAsync(0)
    expect(active).toBe(32)
    await vi.advanceTimersByTimeAsync(8000)
    const expected = Object.fromEntries(fields.map(id => [id, { status: 'ready', value: true }]))
    expect(await result).toEqual(expected)
    expect(peak).toBe(32)
    expect(active).toBe(0)
    expect(await conditions.settings(pkg.id, fields)).toEqual(expected)
    expect(evaluated).toBe(64)
  }
  finally {
    conditions.dispose()
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  }
})

it('cancels invalidated queued conditions before reading snapshots and releases queued work on disposal', async () => {
  const f = evaluationFixture()
  const evaluate = (index: number) => f.engine.evaluate({ ...f.input, scopeKey: `scope-${index}`, reference: { condition, params: { index } } })
  try {
    const running = Array.from({ length: 32 }, (_, index) => evaluate(index))
    await vi.waitFor(() => expect(f.pending).toHaveLength(32))
    const invalidated = evaluate(32)
    const retained = evaluate(33)
    f.engine.invalidate({ scopeKey: 'scope-32' })
    expect(await invalidated).toEqual({ status: 'unavailable', value: false })
    f.pending[0]!.resolve(true)
    await vi.waitFor(() => expect(f.pending).toHaveLength(33))
    f.pending[32]!.resolve(true)
    expect(await retained).toEqual({ status: 'ready', value: true })
    const waiting = Array.from({ length: 4 }, (_, index) => evaluate(index + 34))
    f.engine.dispose()
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: 4 }, () => ({ status: 'unavailable', value: false })))
    await Promise.all(running)
  }
  finally { f.engine.dispose() }
})
