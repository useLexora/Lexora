import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionServicePorts } from '../ExtensionService'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionService } from '../ExtensionService'
import { createStore, manifest, reviewPackage } from './fixtures'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function fixture(overrides: Partial<ExtensionServicePorts> = {}) {
  const { root, store } = await createStore()
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await store.install((await reviewPackage(root, store)).token)
  const hosts: Array<{ broker: (method: string, params: unknown) => Promise<JsonValue>, failed: () => void, disposed: boolean, commands: JsonValue[] }> = []
  const events: unknown[] = []
  const service = new ExtensionService(store, {
    createHost: (_pkg, broker, failed) => {
      const host = { broker, failed, disposed: false, commands: [] as JsonValue[] }
      hosts.push(host)
      return { call: async (method, params) => {
        if (method === 'command')
          host.commands.push(params)
        return null
      }, dispose: async () => {
        host.disposed = true
      }, devtools: () => {} }
    },
    createView: () => ({ token: randomUUID(), url: 'lexora-extension://fixture/__view.html', dispose: () => {} }),
    workbench: async (event) => {
      events.push(event)
      return event.kind === 'state' ? event.viewId : randomUUID()
    },
    readText: async target => `Content of ${target.path}`,
    get: async () => new Response('network'),
    changed: () => {},
    ...overrides,
  })
  cleanup.push(() => service.dispose())
  return { root, store, service, hosts, events }
}
const target = { spaceId: 'space', directoryId: 'directory', revision: 4, path: 'README.md' }

it('publishes static contributions without starting code and deduplicates concurrent activation', async () => {
  const { service, hosts } = await fixture()
  expect((await service.list())[0]?.state).toBe('inactive')
  expect(hosts).toHaveLength(0)
  await Promise.all([service.execute('tests.reader', 'tests.reader.open', null), service.execute('tests.reader', 'tests.reader.open', null)])
  expect(hosts).toHaveLength(1)
  expect(hosts[0]!.commands).toHaveLength(2)
  expect((await service.list())[0]?.state).toBe('active')
})

it('exposes opaque selected-resource grants, revalidates bindings on every read, and blocks other grants', async () => {
  let allowed = true
  const { service, hosts } = await fixture({ readText: async (input) => {
    if (!allowed || input.revision !== 4)
      throw new Error('RESOURCE_REVOKED')
    return 'Selected text'
  } })
  await service.execute('tests.reader', 'tests.reader.open', target)
  const command = hosts[0]!.commands[0] as { resource: { id: string, name: string } }
  expect(Object.keys(command.resource).sort()).toEqual(['id', 'name'])
  expect(await hosts[0]!.broker('resources.readText', { id: command.resource.id })).toBe('Selected text')
  await expect(hosts[0]!.broker('resources.readText', { id: randomUUID() })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(hosts[0]!.broker('shell.execute', {})).rejects.toThrow('EXTENSION_METHOD_DENIED')
  allowed = false
  await expect(hosts[0]!.broker('resources.readText', { id: command.resource.id })).rejects.toThrow('RESOURCE_REVOKED')
})

it('invalidates in-flight requests and old generation brokers on disable and crash', async () => {
  const pending = deferred<string>()
  let wait = false
  const { service, hosts } = await fixture({ readText: async () => wait ? pending.promise : 'Selected' })
  await service.execute('tests.reader', 'tests.reader.open', target)
  const resource = (hosts[0]!.commands[0] as { resource: { id: string } }).resource
  wait = true
  const reading = hosts[0]!.broker('resources.readText', { id: resource.id })
  const rejected = expect(reading).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await service.enable('tests.reader', false)
  pending.resolve('Late contents')
  await rejected
  expect(hosts[0]!.disposed).toBe(true)
  await service.enable('tests.reader', true)
  await service.execute('tests.reader', 'tests.reader.open', null)
  await expect(hosts[0]!.broker('storage.set', { version: 1, value: 'late' })).rejects.toThrow('EXTENSION_HOST_STOPPED')
  hosts[1]!.failed()
  expect((await service.list())[0]).toMatchObject({ state: 'failed', error: 'EXTENSION_HOST_CRASHED', generation: null })
  await expect(service.execute('tests.reader', 'tests.reader.open', null)).rejects.toThrow('EXTENSION_RESTART_REQUIRED')
  await service.restart('tests.reader')
  await service.execute('tests.reader', 'tests.reader.open', null)
  expect((await service.list())[0]?.state).toBe('active')
})

it('invalidates old renderer requests while allowing a fresh renderer to reactivate the host', async () => {
  const { service, hosts } = await fixture()
  await service.execute('tests.reader', 'tests.reader.open', null)
  const generation = (await service.list())[0]!.generation
  await service.resetHosts()
  await expect(hosts[0]!.broker('storage.set', { value: {}, version: 1 })).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await service.execute('tests.reader', 'tests.reader.open', null)
  expect((await service.list())[0]!.generation).not.toBe(generation)
})

it('binds every view to its token and resource, and acknowledges only persisted state', async () => {
  const { service, hosts, events } = await fixture()
  await service.execute('tests.reader', 'tests.reader.open', target)
  const resource = (hosts[0]!.commands[0] as { resource: { id: string, name: string } }).resource
  const input = { viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource, state: { position: 3 }, stateVersion: 1 }
  const first = await service.openView(input)
  const second = await service.openView(input)
  service.closeView(first.id, first.generation, first.token)
  await expect(service.viewRequest(first.id, first.generation, first.token, 'bootstrap', null)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  expect(await service.viewRequest(second.id, second.generation, second.token, 'bootstrap', null)).toMatchObject({ state: { position: 3 } })
  await expect(service.viewRequest(second.id, second.generation, second.token, 'resources.readText', { id: randomUUID() })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(service.viewRequest(second.id, second.generation, second.token, 'storage.get', null)).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await service.viewRequest(second.id, second.generation, second.token, 'view.setState', { position: 9 })
  expect(events).toContainEqual(expect.objectContaining({ kind: 'state', viewId: second.id, generation: second.generation, state: { position: 9 } }))
  await service.enable('tests.reader', false)
  await expect(service.viewRequest(second.id, second.generation, second.token, 'bootstrap', null)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
})

it('does not claim state was saved if the workbench failed to persist it', async () => {
  const { service } = await fixture({ workbench: async () => null })
  const input = { viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource: null, state: {}, stateVersion: 1 }
  await expect(service.openView(input)).rejects.toThrow('EXTENSION_RESOURCE_REQUIRED')
  const grant = await service.store.grant('tests.reader', target)
  const session = await service.openView({ ...input, resource: grant })
  await expect(service.viewRequest(session.id, session.generation, session.token, 'view.setState', { position: 9 })).rejects.toThrow('EXTENSION_STATE_SAVE_FAILED')
})

it('keeps new network permissions inactive until an explicitly approved update is restarted', async () => {
  const get = vi.fn(async () => new Response('allowed'))
  const { root, store, service, hosts } = await fixture({ get })
  await service.execute('tests.reader', 'tests.reader.open', null)
  const update = await reviewPackage(root, store, manifest({ version: '1.1.0', permissions: { selectedResource: 'read', network: ['https://example.com'] } }))
  await service.install(update.token)
  await expect(hosts[0]!.broker('network.get', { url: 'https://example.com/' })).rejects.toThrow('EXTENSION_NETWORK_DENIED')
  expect(get).not.toHaveBeenCalled()
  await service.restart('tests.reader')
  await service.execute('tests.reader', 'tests.reader.open', null)
  expect(await hosts[1]!.broker('network.get', { url: 'https://example.com/' })).toEqual({ status: 200, text: 'allowed' })
  get.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://unapproved.example/' } }))
  await expect(hosts[1]!.broker('network.get', { url: 'https://example.com/' })).rejects.toThrow('EXTENSION_NETWORK_DENIED')
  expect(get).toHaveBeenCalledTimes(2)
})

it('stops dependent hosts when their dependency is disabled', async () => {
  const { root, store, service, hosts } = await fixture()
  await store.install((await reviewPackage(root, store, manifest({ id: 'tests.dependent', dependencies: { 'tests.reader': '^1' } }))).token)
  await service.execute('tests.dependent', 'tests.dependent.open', null)
  expect(hosts).toHaveLength(2)
  await service.enable('tests.reader', false)
  expect(hosts.every(host => host.disposed)).toBe(true)
  expect((await service.list()).find(item => item.manifest.id === 'tests.dependent')).toMatchObject({ state: 'blocked', error: 'EXTENSION_DEPENDENCY_UNAVAILABLE' })
})
