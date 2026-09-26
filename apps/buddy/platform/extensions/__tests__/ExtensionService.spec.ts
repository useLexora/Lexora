import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionServicePorts } from '../ExtensionService'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
      return event.kind === 'interaction' ? event.interactionId : event.kind === 'state' || event.kind === 'regions' ? event.viewId : randomUUID()
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
  expect(events).toContainEqual(expect.objectContaining({ kind: 'state', viewId: second.id, generation: second.generation, token: second.token, state: { position: 9 } }))
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
  expect((await service.list()).find(item => item.manifest.id === 'tests.reader')).toMatchObject({ enabled: false, state: 'disabled', error: null, generation: null })
  expect((await service.list()).find(item => item.manifest.id === 'tests.dependent')).toMatchObject({ state: 'blocked', error: 'EXTENSION_DEPENDENCY_UNAVAILABLE' })
  await service.enable('tests.dependent', false)
  expect((await service.list()).every(item => !item.enabled && item.state === 'disabled' && item.error === null)).toBe(true)
  await service.enable('tests.dependent', true)
  expect((await service.list()).find(item => item.manifest.id === 'tests.dependent')).toMatchObject({ state: 'blocked', error: 'EXTENSION_DEPENDENCY_UNAVAILABLE' })
  await service.enable('tests.reader', true)
  expect((await service.list()).every(item => item.state === 'inactive' && item.error === null)).toBe(true)
})

it('authorizes each placement and control request against its own live view session', async () => {
  const { root, store, service, hosts, events } = await fixture({ workbench: async (event) => {
    events.push(event)
    return event.kind === 'control' ? event.viewId : randomUUID()
  } })
  const value = manifest({ apiVersion: 2, id: 'tests.controls', permissions: { controls: ['model.reasoning'] }, contributes: {
    views: [{ id: 'tests.controls.ui', title: 'Controls', entry: 'view.js', resource: 'none' }],
    placements: [
      { id: 'tests.controls.reasoning', view: 'tests.controls.ui', kind: 'control', target: 'model.reasoning' },
      { id: 'tests.controls.top', view: 'tests.controls.ui', kind: 'view', location: 'workbench.top' },
    ],
  } })
  await service.install((await reviewPackage(root, store, value)).token)
  const input = { viewId: randomUUID(), extensionId: value.id, viewType: 'tests.controls.ui', resource: null, state: null, stateVersion: 1 }
  await expect(service.openView({ ...input, placementId: 'tests.reader.top' })).rejects.toThrow('EXTENSION_PLACEMENT_UNAVAILABLE')
  const session = await service.openView({ ...input, placementId: 'tests.controls.reasoning' })
  const proposal = { revision: randomUUID(), value: 'high' }
  await service.viewRequest(session.id, session.generation, session.token, 'control.propose', proposal)
  expect(events).toContainEqual(expect.objectContaining({ kind: 'control', viewId: session.id, token: session.token, generation: session.generation, proposal }))
  await expect(service.viewRequest(session.id, session.generation, randomUUID(), 'control.propose', proposal)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await expect(service.viewRequest(session.id, session.generation, session.token, 'view.setState', {})).rejects.toThrow('EXTENSION_METHOD_DENIED')
  const ordinary = await service.openView({ ...input, viewId: randomUUID() })
  await expect(service.viewRequest(ordinary.id, ordinary.generation, ordinary.token, 'control.propose', proposal)).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await hosts[0]!.broker('placements.show', { id: 'tests.controls.top' })
  expect(events).toContainEqual(expect.objectContaining({ kind: 'placement', extensionId: value.id, placementId: 'tests.controls.top', visible: true }))
  await expect(hosts[0]!.broker('placements.show', { id: 'tests.controls.reasoning' })).rejects.toThrow('EXTENSION_PLACEMENT_UNAVAILABLE')
  await expect(hosts[0]!.broker('placements.show', { id: 'another.plugin.top' })).rejects.toThrow('EXTENSION_PLACEMENT_UNAVAILABLE')
  await service.enable(value.id, false)
  await expect(service.viewRequest(session.id, session.generation, session.token, 'control.propose', proposal)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
})

it('keeps a content slot limited to its selected view surface', async () => {
  const { root, store, service, hosts } = await fixture()
  const value = manifest({ apiVersion: 3, id: 'tests.footer', contributes: {
    views: [{ id: 'tests.footer.content', title: 'Footer', entry: 'view.js', resource: 'none' }],
    placements: [{ id: 'tests.footer.slot', view: 'tests.footer.content', kind: 'slot', target: 'composer.footer' }],
  } })
  await service.install((await reviewPackage(root, store, value)).token)
  const session = await service.openView({ viewId: randomUUID(), extensionId: value.id, viewType: 'tests.footer.content', placementId: 'tests.footer.slot', resource: null, state: null, stateVersion: 0 })
  const request = (method: string, params: JsonValue) => service.viewRequest(session.id, session.generation, session.token, method, params)
  expect(await request('bootstrap', null)).toEqual(expect.objectContaining({ apiVersion: 3, presentation: 'slot' }))
  await expect(request('view.setState', {})).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(request('view.setPresentation', { height: 200 })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(request('control.propose', { revision: randomUUID(), value: 'high' })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(hosts[0]!.broker('placements.show', { id: 'tests.footer.slot' })).rejects.toThrow('EXTENSION_PLACEMENT_UNAVAILABLE')
})

it('does not let an older concurrent open replace a newer view endpoint', async () => {
  const { store, service } = await fixture()
  const resource = await store.grant('tests.reader', target)
  const original = store.resolveGrant.bind(store)
  const pending = deferred<typeof target>()
  const entered = deferred<void>()
  let requests = 0
  vi.spyOn(store, 'resolveGrant').mockImplementation(async (...args) => {
    if (++requests === 1) {
      entered.resolve()
      return pending.promise
    }
    return original(...args)
  })
  const input = { viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource, state: {}, stateVersion: 1 }
  const first = service.openView(input)
  const rejected = expect(first).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await entered.promise
  const current = await service.openView({ ...input, state: { restored: true } })
  pending.resolve(target)
  await rejected
  expect(await service.viewRequest(current.id, current.generation, current.token, 'bootstrap', null)).toMatchObject({ state: { restored: true } })
})

it('records a failed view without failing its host or other views', async () => {
  const { store, service } = await fixture()
  const resource = await store.grant('tests.reader', target)
  const input = { viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource, state: {}, stateVersion: 1 }
  const failed = await service.openView(input)
  const retained = await service.openView({ ...input, viewId: randomUUID() })
  await service.viewRequest(failed.id, failed.generation, failed.token, 'view.failed', { code: 'EXTENSION_VIEW_TIMEOUT' })
  service.closeView(failed.id, failed.generation, failed.token)
  const status = (await service.list())[0]!
  expect(status).toMatchObject({ state: 'active', error: null })
  expect(status.logs.at(-1)).toMatchObject({ event: 'view.failed', code: 'EXTENSION_VIEW_TIMEOUT' })
  expect(await service.viewRequest(retained.id, retained.generation, retained.token, 'bootstrap', null)).toMatchObject({ state: {} })
})

it('rejects unauthorized media and late picker selections without retaining grants', async () => {
  const selection = deferred<string[]>()
  const entered = deferred<void>()
  const f = await fixture({ selectResources: async () => {
    entered.resolve()
    return selection.promise
  } })
  const value = manifest({ apiVersion: 2, id: 'tests.media', permissions: { localResources: true }, contributes: { views: [{ id: 'tests.media.page', title: 'Media', entry: 'view.js', resource: 'none' }] } })
  const path = join(f.root, 'track.mp3')
  await writeFile(path, 'media bytes')
  await f.service.install((await reviewPackage(f.root, f.store, value)).token)
  const input = { viewId: randomUUID(), extensionId: value.id, viewType: 'tests.media.page', resource: null, state: {}, stateVersion: 1 }
  const view = await f.service.openView(input)
  await expect(f.hosts.at(-1)!.broker('resources.pickFiles', {})).rejects.toThrow('EXTENSION_METHOD_DENIED')
  const picking = f.service.viewRequest(view.id, view.generation, view.token, 'resources.pickFiles', {})
  const rejected = expect(picking).rejects.toThrow()
  await entered.promise
  f.service.closeView(view.id, view.generation, view.token)
  selection.resolve([path])
  await rejected
  expect(await f.store.resources.list(value.id)).toEqual([])
  const resource = await f.store.grant('tests.reader', target)
  const denied = await f.service.openView({ ...input, viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource })
  await expect(f.service.viewRequest(denied.id, denied.generation, denied.token, 'resources.listFiles', null)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
})

it('binds presentation changes to a current declared placement and reports real installation state', async () => {
  const f = await fixture({ workbench: async event => event.kind === 'presentation' ? event.viewId : null })
  const value = manifest({ apiVersion: 2, id: 'tests.panel', contributes: { views: [{ id: 'tests.panel.ui', title: 'Panel', entry: 'view.js', resource: 'none' }], placements: [{ id: 'tests.panel.float', kind: 'view', location: 'workbench.floating', view: 'tests.panel.ui' }] } })
  await f.service.install((await reviewPackage(f.root, f.store, value)).token)
  const input = { viewId: randomUUID(), extensionId: value.id, viewType: 'tests.panel.ui', resource: null, state: { secret: 'private-state' }, stateVersion: 1 }
  const view = await f.service.openView({ ...input, placementId: 'tests.panel.float' })
  const request = (method: string, params: JsonValue) => f.service.viewRequest(view.id, view.generation, view.token, method, params)
  await request('view.setPresentation', { height: 260, width: 360, position: 'absolute', right: 0 })
  await expect(request('view.setPresentation', { height: 99999 })).rejects.toThrow()
  await request('view.ready', null)
  const status = await f.service.inspect(value.id)
  expect(status).toMatchObject({ installed: true, version: '1.0.0', state: 'active', views: [{ type: 'tests.panel.ui', placement: 'tests.panel.float', ready: true, error: null }] })
  expect(JSON.stringify(status)).not.toContain('private-state')
  const page = await f.service.openView({ ...input, viewId: randomUUID() })
  await expect(f.service.viewRequest(page.id, page.generation, page.token, 'view.setPresentation', { height: 260 })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await f.service.enable(value.id, false)
  expect(await f.service.inspect(value.id)).toMatchObject({ state: 'disabled', views: [] })
  await expect(request('view.setPresentation', { height: 100 })).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
})

it('keeps export permission separate from reads and expires writers with their owning view', async () => {
  let destination = ''
  const f = await fixture({ selectSavePath: async () => destination })
  destination = join(f.root, 'export.binary')
  await writeFile(destination, 'original')
  const value = manifest({ apiVersion: 2, id: 'tests.export', permissions: { localResources: true }, contributes: { views: [{ id: 'tests.export.page', title: 'Export', entry: 'view.js', resource: 'none' }] } })
  await f.service.install((await reviewPackage(f.root, f.store, value)).token)
  const input = { viewId: randomUUID(), extensionId: value.id, viewType: 'tests.export.page', resource: null, state: null, stateVersion: 1 }
  const readOnly = await f.service.openView(input)
  const payload = { name: 'file.unknown', size: 4 }
  await expect(f.service.viewRequest(readOnly.id, readOnly.generation, readOnly.token, 'resources.beginSave', payload)).rejects.toThrow('EXTENSION_RESOURCE_EXPORT_DENIED')
  await f.service.install((await reviewPackage(f.root, f.store, manifest({ ...value, version: '1.1.0', permissions: { resourceExport: true } }))).token)
  await f.service.restart(value.id)
  const owner = await f.service.openView(input)
  const other = await f.service.openView({ ...input, viewId: randomUUID() })
  const request = (method: string, params: JsonValue) => f.service.viewRequest(owner.id, owner.generation, owner.token, method, params)
  await expect(request('resources.listFiles', null)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  const id = await request('resources.beginSave', payload)
  await expect(f.service.viewRequest(other.id, other.generation, other.token, 'resources.commitSave', { id })).rejects.toThrow('EXTENSION_RESOURCE_WRITE_EXPIRED')
  await request('resources.writeChunk', { id, offset: 0, base64: Buffer.from('new!').toString('base64') })
  f.service.closeView(owner.id, owner.generation, owner.token)
  await expect(request('resources.commitSave', { id })).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  expect(await readFile(destination, 'utf8')).toBe('original')
})

it.each([false, true])('limits menu invocation to user-selected content with permission %s', async (selectedContent) => {
  const { root, store, service, hosts } = await fixture()
  const value = manifest({ apiVersion: 3, id: 'tests.actions', permissions: { selectedContent, selectedResource: 'read' }, contributes: {
    commands: [{ id: 'tests.actions.run', title: 'Run', hidden: true }],
    menus: ['composer', 'message', 'task', 'resource'].map(kind => ({ id: `tests.actions.${kind}`, command: 'tests.actions.run', target: `${kind}.actions` as 'composer.actions' | 'message.actions' | 'task.actions' | 'resource.actions' })),
    views: [{ id: 'tests.actions.view', title: 'View', entry: 'view.js', resource: 'none' }],
  } })
  await service.install((await reviewPackage(root, store, value)).token)
  const instanceId = randomUUID()
  await service.executeMenu(value.id, 'tests.actions.composer', { target: 'composer.actions', instanceId, content: 'Selected draft', resource: target })
  expect(hosts[0]!.commands.at(-1)).toEqual({ command: 'tests.actions.run', resource: null, arguments: null, invocation: { target: 'composer.actions', instanceId, ...(selectedContent ? { content: 'Selected draft' } : {}) } })
  await service.executeMenu(value.id, 'tests.actions.task', { target: 'task.actions', instanceId, content: 'Unrelated text', resource: target })
  expect(hosts[0]!.commands.at(-1)).toMatchObject({ resource: null, invocation: { target: 'task.actions', instanceId } })
  expect(JSON.stringify(hosts[0]!.commands.at(-1))).not.toContain('Unrelated text')
  await service.executeMenu(value.id, 'tests.actions.resource', { target: 'resource.actions', instanceId, content: 'Unrelated text', resource: target })
  const fileCommand = hosts[0]!.commands.at(-1) as { resource: { id: string, name: string } }
  expect(fileCommand.resource).toEqual({ id: expect.any(String), name: 'README.md' })
  expect(await hosts[0]!.broker('resources.readText', { id: fileCommand.resource.id })).toBe('Content of README.md')
  await expect(service.executeMenu(value.id, 'tests.actions.composer', { target: 'message.actions', resource: null })).rejects.toThrow('EXTENSION_COMMAND_UNAVAILABLE')
  const session = await service.openView({ viewId: randomUUID(), extensionId: value.id, instanceId, viewType: 'tests.actions.view', resource: null, state: {}, stateVersion: 1 })
  await service.viewRequest(session.id, session.generation, session.token, 'commands.execute', { command: 'tests.actions.run', arguments: null })
  expect(hosts[0]!.commands.at(-1)).toEqual({ command: 'tests.actions.run', arguments: null, resource: null, invocation: { target: 'view', instanceId } })
  await expect(service.viewRequest(session.id, session.generation, session.token, 'commands.execute', { command: 'tests.actions.run', arguments: null, invocation: { target: 'composer.actions', content: 'forged' } })).rejects.toThrow()
})

it('carries pane identity through scoped placement requests and rejects scope on global mounts', async () => {
  const { root, store, service, hosts, events } = await fixture()
  const value = manifest({ apiVersion: 3, id: 'tests.panes', contributes: {
    views: [{ id: 'tests.panes.view', title: 'Pane', entry: 'view.js', resource: 'none' }],
    placements: [
      { id: 'tests.panes.local', kind: 'view', target: 'workbench.pane', view: 'tests.panes.view' },
      { id: 'tests.panes.global', kind: 'view', target: 'workbench', view: 'tests.panes.view' },
    ],
  } })
  await service.install((await reviewPackage(root, store, value)).token)
  const instanceId = randomUUID()
  const session = await service.openView({ viewId: randomUUID(), extensionId: value.id, viewType: 'tests.panes.view', instanceId, placementId: 'tests.panes.local', resource: null, state: {}, stateVersion: 1 })
  expect(await service.viewRequest(session.id, session.generation, session.token, 'bootstrap', null)).toMatchObject({ instanceId })
  await hosts[0]!.broker('placements.show', { id: 'tests.panes.local', instanceId })
  await hosts[0]!.broker('placements.hide', { id: 'tests.panes.local', instanceId })
  expect(events).toEqual([
    expect.objectContaining({ kind: 'placement', instanceId, visible: true }),
    expect.objectContaining({ kind: 'placement', instanceId, visible: false }),
  ])
  await expect(hosts[0]!.broker('placements.show', { id: 'tests.panes.global', instanceId })).rejects.toThrow('EXTENSION_PLACEMENT_UNAVAILABLE')
})

async function interactionFixture() {
  const f = await fixture()
  const value = manifest({ apiVersion: 3, id: 'tests.game', contributes: {
    commands: [{ id: 'tests.game.start', title: 'Start', slash: { name: 'game-start' } }],
    views: [{ id: 'tests.game.view', title: 'Game', entry: 'view.js', resource: 'none' }],
    placements: [{ id: 'tests.game.layer', kind: 'view', view: 'tests.game.view', target: 'workbench', interaction: 'regions', presentation: { position: 'absolute', width: '100%', height: '100%' } }],
  } })
  await f.service.install((await reviewPackage(f.root, f.store, value)).token)
  await f.service.execute(value.id, 'tests.game.start', null)
  return { ...f, broker: f.hosts[0]!.broker, input: { extensionId: value.id, viewId: randomUUID(), viewType: 'tests.game.view', placementId: 'tests.game.layer', resource: null, state: {}, stateVersion: 1 } }
}

it('passes explicit slash arguments and origin only, and rejects obsolete panes', async () => {
  const f = await interactionFixture()
  const pane = { id: randomUUID(), active: true, visible: true, rect: { x: 0, y: 0, width: 300, height: 400 } }
  f.service.updatePanes([pane])
  await f.service.executeSlash('tests.game', 'tests.game.start', 'level=2', pane.id)
  expect(f.hosts[0]!.commands.at(-1)).toEqual({ command: 'tests.game.start', resource: null, arguments: 'level=2', invocation: { target: 'slash', instanceId: pane.id } })
  f.service.updatePanes([{ ...pane, visible: false }])
  await expect(f.service.executeSlash('tests.game', 'tests.game.start', '', pane.id)).rejects.toThrow('EXTENSION_COMMAND_UNAVAILABLE')
  await expect(f.service.executeSlash('tests.reader', 'tests.reader.open', '')).rejects.toThrow('EXTENSION_COMMAND_UNAVAILABLE')
})

it('allows the same local name in different plugin namespaces without sharing handlers', async () => {
  const f = await interactionFixture()
  const value = manifest({ id: 'tests.other', apiVersion: 3, contributes: { commands: [{ id: 'tests.other.start', title: 'Start', slash: { name: 'game-start' } }] } })
  await f.service.install((await reviewPackage(f.root, f.store, value)).token)
  await f.service.executeSlash(value.id, 'tests.other.start', 'second')
  await f.service.executeSlash('tests.game', 'tests.game.start', 'first')
  expect((await f.service.list()).filter(item => item.state === 'active').map(item => item.manifest.id).sort()).toEqual(['tests.game', 'tests.other'])
  expect(f.hosts[0]!.commands.at(-1)).toMatchObject({ command: 'tests.game.start', arguments: 'first' })
  expect(f.hosts[1]!.commands.at(-1)).toMatchObject({ command: 'tests.other.start', arguments: 'second' })
})

it('requires an owned live interaction and immediately revokes its views on exit', async () => {
  const f = await interactionFixture()
  await expect(f.service.openView(f.input)).rejects.toThrow('EXTENSION_INTERACTION_REQUIRED')
  const id = randomUUID()
  await f.broker('interactions.start', { id, title: 'Game' })
  await f.broker('placements.show', { id: 'tests.game.layer', interactionId: id })
  const view = await f.service.openView({ ...f.input, interactionId: id })
  const request = (method: string, params: JsonValue) => f.service.viewRequest(view.id, view.generation, view.token, method, params)
  expect(await request('bootstrap', null)).toMatchObject({ interactionId: id, interactionMode: 'regions' })
  await request('interaction.setRegions', [{ id: 'target', label: 'Hit target', rect: { x: 20, y: 20, width: 48, height: 48 } }])
  await expect(request('interaction.setRegions', [{ id: 'target', label: '', rect: { x: 0, y: 0, width: -1, height: 20 } }])).rejects.toThrow()
  await expect(request('view.setPresentation', { target: 'app.sidebar' })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await f.service.execute('tests.reader', 'tests.reader.open', null)
  await expect(f.hosts[1]!.broker('interactions.end', { id })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await f.service.endInteraction(id)
  await expect(request('bootstrap', null)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await expect(f.broker('placements.show', { id: 'tests.game.layer', interactionId: id })).rejects.toThrow('EXTENSION_INTERACTION_ENDED')
  await expect(f.service.openView({ ...f.input, interactionId: id })).rejects.toThrow('EXTENSION_INTERACTION_ENDED')
  expect(f.events).toContainEqual(expect.objectContaining({ kind: 'interaction', interactionId: id, title: null }))
})

it('cancels interaction endpoints when the host stops and keeps broadcasts owned', async () => {
  const f = await interactionFixture()
  const id = randomUUID()
  await f.broker('interactions.start', { id, title: 'Game' })
  const view = await f.service.openView({ ...f.input, interactionId: id })
  await f.broker('views.broadcast', { score: 3 })
  expect(f.events).toContainEqual(expect.objectContaining({ kind: 'message', extensionId: 'tests.game', generation: view.generation, message: { score: 3 } }))
  await f.service.enable('tests.game', false)
  await expect(f.service.viewRequest(view.id, view.generation, view.token, 'bootstrap', null)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  expect(f.events).toContainEqual(expect.objectContaining({ kind: 'interaction', interactionId: id, title: null }))
})

it('rejects a duplicate plugin namespace and releases it when the original host stops', async () => {
  const f = await interactionFixture()
  const value = manifest({ id: 'other.game', apiVersion: 3, contributes: { commands: [{ id: 'other.game.run', title: 'Run', slash: { name: 'run' } }] } })
  await f.service.install((await reviewPackage(f.root, f.store, value)).token)
  await expect(f.service.executeSlash(value.id, 'other.game.run', '')).rejects.toThrow('EXTENSION_COMMAND_NAMESPACE_CONFLICT')
  expect((await f.service.list()).find(item => item.manifest.id === 'tests.game')?.state).toBe('active')
  await f.service.enable('tests.game', false)
  await f.service.restart(value.id)
  await f.service.executeSlash(value.id, 'other.game.run', '')
  expect((await f.service.list()).find(item => item.manifest.id === value.id)?.state).toBe('active')
})
