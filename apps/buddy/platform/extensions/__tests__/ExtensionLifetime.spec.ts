import type { ExtensionAgentInvocation } from '../../../shared/extensions/extensionAgent'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionServicePorts } from '../ExtensionService'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionService } from '../ExtensionService'
import { createStore, manifest, reviewPackage } from './fixtures'

type Broker = (method: string, params: unknown) => Promise<JsonValue>
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const action of cleanup.splice(0).reverse()) await action()
})
function definition(id = 'tests.service', scope: 'desktop' | 'service' = 'service', dependencies = {}) {
  return manifest({ id, apiVersion: 5, executionScope: scope, dependencies, permissions: { agent: true, network: ['https://example.com'] }, contributes: {
    commands: [{ id: `${id}.open`, title: 'Open' }],
    views: [{ id: `${id}.view`, title: 'View', entry: 'view.js', resource: 'none' }],
    agent: { tools: [{ id: `${id}.tool`, title: 'Tool', description: 'Fixture', parameters: { type: 'object', properties: {} } }] },
  } })
}
async function fixture(overrides: Partial<ExtensionServicePorts> = {}, definitions = [definition()]) {
  const { root, store } = await createStore()
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  for (const value of definitions) await store.install((await reviewPackage(root, store, value)).token)
  const hosts: Array<{ id: string, broker: Broker, disposed: boolean }> = []
  const service = new ExtensionService(store, {
    desktopAvailable: () => false,
    createHost: (pkg, broker) => {
      const host = { id: pkg.manifest.id, broker, disposed: false }
      hosts.push(host)
      return { call: async () => null, dispose: async () => {
        host.disposed = true
      }, devtools: () => {} }
    },
    createView: () => ({ token: randomUUID(), url: 'lexora-extension://fixture/view', dispose: () => {} }),
    changed: () => {},
    workbench: async event => event.requestId,
    get: async () => new Response('network'),
    readText: async () => '',
    ...overrides,
  })
  cleanup.push(() => service.dispose())
  async function input(id = definitions.at(-1)!.id, runId: string | null = 'run'): Promise<ExtensionAgentInvocation> {
    const descriptor = (await service.agentContributions()).find(item => item.id === id)!
    return { extensionId: id, revision: descriptor.revision, configurationRevision: descriptor.configurationRevision, invocationId: randomUUID(), tool: `${id}.tool`, input: {}, context: { taskId: 'task', runId } }
  }
  return { service, store, hosts, input }
}
const scoped = (broker: Broker, invocationId: string, method: string, params: JsonValue = null) => broker('invocation.request', { invocationId, method, params })

it('allows controlled activation storage, but grants effects only to a live invocation and preserves that fence across awaits', async () => {
  let broker!: Broker
  let invocationId = ''
  let lateWrite: Promise<JsonValue> | undefined
  const writeEntered = deferred<void>()
  const writeRelease = deferred<void>()
  const callbackRelease = deferred<void>()
  const f = await fixture({ createHost: (_pkg, request) => {
    broker = request
    return { call: async (method, params) => {
      if (method === 'activate') {
        await broker('storage.set', { value: { initialized: true }, version: 1 })
        await expect(broker('network.get', { url: 'https://example.com' })).rejects.toThrow('EXTENSION_INVOCATION_REQUIRED')
      }
      if (method === 'agent.invoke') {
        invocationId = (params as { invocationId: string }).invocationId
        expect(await scoped(broker, invocationId, 'network.get', { url: 'https://example.com' })).toMatchObject({ text: 'network' })
        await expect(broker('storage.set', { value: { unowned: true }, version: 1 })).rejects.toThrow('EXTENSION_INVOCATION_REQUIRED')
        lateWrite = scoped(broker, invocationId, 'storage.set', { value: { late: true }, version: 1 })
        void lateWrite.catch(() => {})
        await callbackRelease.promise
        return 'done'
      }
      return null
    }, dispose: async () => {}, devtools: () => {} }
  } })
  const save = f.store.saveData.bind(f.store)
  vi.spyOn(f.store, 'saveData').mockImplementation(async (...args) => {
    if ((args[1] as { late?: boolean }).late) {
      writeEntered.resolve()
      await writeRelease.promise
    }
    return save(...args)
  })
  const request = await f.input()
  const running = f.service.invokeAgent(request, new AbortController().signal)
  await writeEntered.promise
  callbackRelease.resolve()
  await vi.waitFor(async () => {
    await expect(scoped(broker, invocationId, 'storage.get')).rejects.toThrow()
  })
  writeRelease.resolve()
  expect(await running).toBe('done')
  await expect(lateWrite).rejects.toThrow()
  expect((await f.store.data('tests.service')).value).toEqual({ initialized: true })
  await expect(scoped(broker, invocationId, 'network.get', { url: 'https://example.com' })).rejects.toThrow('EXTENSION_INVOCATION_EXPIRED')
})

it('withdraws desktop plugins and UI tokens while a service invocation keeps the same instance and data owner', async () => {
  const hold = deferred<void>()
  const started = deferred<void>()
  const disposed = new Set<string>()
  const brokers = new Map<string, Broker>()
  const invocations = new Map<string, string>()
  const f = await fixture({ desktopAvailable: () => true, createHost: (pkg, broker) => {
    const id = pkg.manifest.id
    brokers.set(id, broker)
    return { call: async (method, params, signal) => {
      if (method === 'agent.invoke') {
        invocations.set(id, (params as { invocationId: string }).invocationId)
        if (invocations.size === 2)
          started.resolve()
        await Promise.race([hold.promise, new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))])
        return id
      }
      return null
    }, dispose: async () => { disposed.add(id) }, devtools: () => {} }
  } }, [definition('tests.desktop', 'desktop'), definition()])
  const serviceInput = await f.input()
  const desktopInput = await f.input('tests.desktop')
  const pending = f.service.invokeAgent(serviceInput, new AbortController().signal)
  const old = f.service.invokeAgent(desktopInput, new AbortController().signal)
  const rejected = expect(old).rejects.toThrow('EXTENSION_AGENT_CANCELLED')
  await started.promise
  const view = await f.service.openView({ viewId: randomUUID(), extensionId: 'tests.service', viewType: 'tests.service.view', resource: null, state: null, stateVersion: 1 })
  const generation = (await f.service.list()).find(item => item.manifest.id === 'tests.service')!.generation
  await f.service.detachDesktop()
  await rejected
  expect(disposed).toEqual(new Set(['tests.desktop']))
  expect((await f.service.agentContributions()).map(item => item.id)).toEqual(['tests.service'])
  await expect(f.service.openView({ viewId: randomUUID(), extensionId: 'tests.service', viewType: 'tests.service.view', resource: null, state: null, stateVersion: 1 })).rejects.toThrow('EXTENSION_DESKTOP_REQUIRED')
  await expect(scoped(brokers.get('tests.service')!, serviceInput.invocationId, 'views.open', { type: 'tests.service.view', resource: null, state: {} })).rejects.toThrow('EXTENSION_DESKTOP_REQUIRED')
  expect(await scoped(brokers.get('tests.service')!, serviceInput.invocationId, 'network.get', { url: 'https://example.com' })).toMatchObject({ text: 'network' })
  f.service.attachDesktop()
  expect((await f.service.list()).find(item => item.manifest.id === 'tests.service')!.generation).toBe(generation)
  await expect(f.service.viewRequest(view.id, view.generation, view.token, 'storage.get', null)).rejects.toThrow()
  hold.resolve()
  expect(await pending).toBe('tests.service')
})

it('retains a single service dependency closure until its run ends, then stops unused instances within the idle bound', async () => {
  const f = await fixture({}, [definition('tests.base'), definition('tests.service', 'service', { 'tests.base': '^1.0.0' })])
  const first = await f.input()
  await f.service.invokeAgent(first, new AbortController().signal)
  const second = await f.input()
  await f.service.invokeAgent(second, new AbortController().signal)
  expect(f.hosts.map(host => host.id)).toEqual(['tests.base', 'tests.service'])
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.hosts.every(host => !host.disposed)).toBe(true)
  f.service.releaseRun('run')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.hosts.every(host => host.disposed)).toBe(true)
})

it('counts a desktop view as a service use and retires it after the last view and Core lifetime are released', async () => {
  const f = await fixture({ desktopAvailable: () => true })
  await f.service.invokeAgent(await f.input(), new AbortController().signal)
  const view = await f.service.openView({ viewId: randomUUID(), extensionId: 'tests.service', viewType: 'tests.service.view', resource: null, state: null, stateVersion: 1 })
  f.service.releaseAllRuns()
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.hosts[0]!.disposed).toBe(false)
  f.service.closeView(view.id, view.generation, view.token)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.hosts[0]!.disposed).toBe(true)
})

it('does not redirect an in-flight UI request to a new Desktop attachment', async () => {
  let broker!: Broker
  const entered = deferred<void>()
  const release = deferred<void>()
  const f = await fixture({ desktopAvailable: () => true, createHost: (_pkg, request) => {
    broker = request
    return { call: async (method, params) => method === 'agent.invoke'
      ? scoped(broker, (params as { invocationId: string }).invocationId, 'views.open', { type: 'tests.service.view', resource: null, state: {} })
      : null, dispose: async () => {}, devtools: () => {} }
  }, workbench: async (event, signal) => {
    entered.resolve()
    await release.promise
    signal?.throwIfAborted()
    return event.requestId
  } })
  const request = f.service.invokeAgent(await f.input(), new AbortController().signal)
  const rejected = expect(request).rejects.toThrow('EXTENSION_DESKTOP_REQUIRED')
  await entered.promise
  await f.service.detachDesktop()
  f.service.attachDesktop()
  release.resolve()
  await rejected
})
