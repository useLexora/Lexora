import type { ApplicationDiagnostic } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ExtensionHostFailure } from '../../../shared/extensions/extensionDiagnostic'
import type { InferenceResourceEvents, InferenceResourceProgress, InferenceResourceSet } from '../../../shared/extensions/extensionInference'
import type { ExtensionMcpConnectorContribution } from '../../../shared/extensions/extensionMcpConnectors'
import type { ExtensionLocalFile } from '../../../shared/extensions/extensionResources'
import type { ExtensionSubagentContribution } from '../../../shared/extensions/extensionSubagents'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionServicePorts } from '../ExtensionService'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { deferred } from '@buddy-tests/deferred'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { afterEach, expect, it, vi } from 'vitest'
import { readSpaceFileResource } from '../../../electron/main/extensions/readSpaceFileResource'
import { ExtensionHostEvents } from '../../../electron/main/extensions/runtime/ExtensionHostEvents'
import { applicationDiagnosticSchema } from '../../../shared/diagnostics/applicationDiagnostic'
import { extensionInspectionSchema } from '../../../shared/extensions/extensionAuthoring'
import { createExtensionInferenceClient } from '../../../shared/extensions/extensionInferenceClient'
import { EXTENSION_NETWORK_LINK_BYTES_LIMIT } from '../../../shared/extensions/extensionNetwork'
import { createExtensionNetworkClient, createExtensionResourceClient } from '../../../shared/extensions/extensionResourceClient'
import { EXTENSION_CREATED_FILES_LIMIT } from '../../../shared/extensions/extensionResources'
import { DEFAULT_THEME_PREFERENCE } from '../../../shared/theme/themePreferences'
import { ThemeService } from '../../themes/ThemeService'
import { ExtensionService } from '../ExtensionService'
import { NativeInferenceProcess } from '../NativeInferenceProcess'
import { observeExtensionDiagnostics } from '../observeExtensionDiagnostics'
import { createStore, manifest, reviewPackage } from './fixtures'
import { invocation, memoryInference } from './inferenceFixtures'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})
async function fixture(overrides: Partial<ExtensionServicePorts> = {}, initialManifest = manifest(), initialFiles: Record<string, string> = {}) {
  const { root, store } = await createStore()
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await store.install((await reviewPackage(root, store, initialManifest, initialFiles)).token)
  const hosts: Array<{ broker: (method: string, params: unknown) => Promise<JsonValue>, failed: (failure?: ExtensionHostFailure) => void, disposed: boolean, commands: JsonValue[] }> = []
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
      return event.kind === 'placement' || event.kind === 'clear-data' ? event.requestId : event.kind === 'interaction' ? event.interactionId : event.kind === 'state' || event.kind === 'regions' || event.kind === 'activity' ? event.viewId : randomUUID()
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

it('hashes local, private and current selected Space resources through one client request', async () => {
  const source = join(await createTemporaryDirectory('lexora-hash-space-'), 'README.md')
  const bytes = Buffer.from('local model bytes')
  await writeFile(source, bytes)
  const expected = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
  let allowed = true
  const f = await fixture({ readResource: (target, signal, request) => readSpaceFileResource(target, signal, async () => {
    if (!allowed)
      throw new Error('RESOURCE_REVOKED')
    return { path: source, kind: 'file' }
  }, request) }, manifest({ apiVersion: 4, permissions: { selectedResource: 'read', localResources: true } }))
  await f.service.execute('tests.reader', 'tests.reader.open', target)
  const resource = (f.hosts[0]!.commands[0] as { resource: { id: string, name: string } }).resource
  const background = createExtensionResourceClient(f.hosts[0]!.broker)
  expect(await background.hash(resource)).toEqual(expected)
  const view = await f.service.openView({ viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource, state: null, stateVersion: 1 })
  const request = (method: string, params: unknown) => f.service.viewRequest(view.id, view.generation, view.token, method, params)
  const client = createExtensionResourceClient(request)
  expect(await client.hash(resource)).toEqual(expected)
  const otherSelected = await f.store.grant('tests.reader', { ...target, path: 'other.md' })
  await expect(client.hash(otherSelected)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  const [local] = await f.store.resources.grant('tests.reader', [source], () => {})
  expect(await background.hash(local!)).toEqual(expected)
  expect(await client.hash(local!)).toEqual(expected)
  const privateFile = await background.createFile({ name: 'private.bin', data: bytes })
  expect(await client.hash(privateFile)).toEqual(expected)
  await expect(request('resources.hash', { id: randomUUID(), resourceId: local!.id, path: source })).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  await expect(background.hash({ id: randomUUID() })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  allowed = false
  await expect(client.hash(resource)).rejects.toThrow('RESOURCE_REVOKED')
})

it.each(['signal', 'close', 'disable', 'revoke'] as const)('stops resource hashing on %s and prevents another owner from cancelling it', async (ending) => {
  const f = await fixture({}, manifest({ apiVersion: 4, permissions: { selectedResource: 'read', localResources: true } }))
  const path = join(f.root, 'model.bin')
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 7))
  const [resource] = await f.store.resources.grant('tests.reader', [path], () => {})
  const selected = await f.store.grant('tests.reader', target)
  const view = await f.service.openView({ viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource: selected, state: null, stateVersion: 1 })
  const started = deferred<void>()
  const release = deferred<void>()
  const original = f.store.resources.response.bind(f.store.resources)
  vi.spyOn(f.store.resources, 'response').mockImplementationOnce(async (...args) => {
    const response = await original(...args)
    started.resolve()
    await release.promise
    return response
  })
  let operationId = ''
  const client = createExtensionResourceClient((method, params) => {
    if (method === 'resources.hash')
      operationId = (params as { id: string }).id
    return f.service.viewRequest(view.id, view.generation, view.token, method, params)
  })
  const controller = new AbortController()
  const pending = client.hash(resource!, { signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow()
  await started.promise
  await expect(f.hosts[0]!.broker('network.cancel', { id: operationId })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  if (ending === 'signal')
    controller.abort(new Error('TEST_CANCELLED'))
  else if (ending === 'close')
    f.service.closeView(view.id, view.generation, view.token)
  else if (ending === 'revoke')
    await f.store.resources.revoke('tests.reader', resource!.id)
  if (ending === 'disable')
    await f.service.enable('tests.reader', false)
  release.resolve()
  await rejected
  expect((await readFile(path)).length).toBe(4 * 1024 * 1024)
})

it('publishes packaged skills without activating hosts and follows dependency, enabled and promoted package state', async () => {
  const id = 'tests.workbook'
  const dependencyId = 'tests.base'
  const path = 'skills/workbook/SKILL.md'
  const content = '---\nname: workbook\ndescription: Inspect workbook files.\n---\n\nOriginal workbook instructions.\n'
  const value = manifest({ id, apiVersion: 4, entry: undefined, permissions: {}, dependencies: { [dependencyId]: '^1.0.0' }, contributes: { skills: [{ id: `${id}.guide`, path }] } })
  const { root, store, service, hosts } = await fixture({}, value, { [path]: content })
  const dependency = manifest({ id: dependencyId, apiVersion: 4, entry: undefined, permissions: {}, contributes: {} })
  await service.install((await reviewPackage(root, store, dependency)).token)
  const initial = store.installed[id]!.current
  const descriptors = await service.skillContributions()
  expect(descriptors).toEqual([{
    extensionId: id,
    extensionName: value.name,
    revision: initial.revision,
    root: store.packageRoot(initial),
    enabled: true,
    skills: [{ id: `${id}.guide`, path }],
    hashes: { [path]: initial.hashes[path] },
  }])
  expect(hosts).toHaveLength(0)

  await service.enable(id, false)
  expect(await service.skillContributions()).toEqual([{ ...descriptors[0], enabled: false }])
  await service.enable(id, true)
  expect(await service.skillContributions()).toEqual(descriptors)
  await service.enable(dependencyId, false)
  expect(store.installed[id]!.enabled).toBe(true)
  expect(await service.skillContributions()).toEqual([{ ...descriptors[0], enabled: false }])
  await service.enable(dependencyId, true)
  expect(await service.skillContributions()).toEqual(descriptors)

  const updatedContent = content.replace('Original workbook instructions.', 'Updated workbook instructions.')
  await service.install((await reviewPackage(root, store, { ...value, version: '1.1.0' }, { [path]: updatedContent })).token)
  const pending = store.installed[id]!.pending!
  expect(pending.revision).not.toBe(initial.revision)
  expect(await service.skillContributions()).toEqual(descriptors)
  await service.applyUpdate(id)
  expect(await service.skillContributions()).toEqual([{
    ...descriptors[0],
    revision: pending.revision,
    root: store.packageRoot(pending),
    hashes: { [path]: pending.hashes[path] },
  }])
  expect(pending.hashes[path]).not.toBe(initial.hashes[path])
  await service.uninstall(id)
  expect(await service.skillContributions()).toEqual([])
  expect(hosts).toHaveLength(0)
})

it.each([false, true])('uninstalls with clearData=%s while preserving other plugins and external files', async (clearData) => {
  const { root, store, service, hosts } = await fixture()
  const id = 'tests.reader'
  const another = 'tests.reader-other'
  await store.install((await reviewPackage(root, store, manifest({ id: another }))).token)
  await store.saveData(another, { retained: true }, 1)
  await store.saveData(id, { old: true }, 1)
  await store.saveConfiguration(id, { enabled: false })
  const external = join(root, 'user-document.txt')
  await writeFile(external, 'user content')
  await store.resources.grant(id, [external], () => {})
  if (process.platform !== 'win32')
    await symlink(external, join(store.root, 'data', id, 'external-link'))
  await service.execute(id, `${id}.open`, null)
  const write = hosts[0]!.broker('storage.set', { value: { current: true }, version: 1 })
  const completed = Promise.allSettled([write])
  await service.uninstall(id, clearData)
  await completed
  await expect(hosts[0]!.broker('storage.set', { value: 'late', version: 1 })).rejects.toThrow('EXTENSION_HOST_STOPPED')
  expect((await service.list()).map(plugin => plugin.manifest.id)).toEqual([another])
  expect(await store.data(another)).toEqual({ version: 1, value: { retained: true } })
  expect(await readFile(external, 'utf8')).toBe('user content')
  if (clearData)
    await expect(readFile(join(store.root, 'data', id, 'configuration.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  else
    expect(JSON.parse(await readFile(join(store.root, 'data', id, 'configuration.json'), 'utf8'))).toEqual({ enabled: false })
  expect(await store.data(id)).toEqual(clearData ? { version: 0, value: {} } : expect.objectContaining({ version: 1 }))
  await store.install((await reviewPackage(root, store)).token)
  expect(await store.resources.list(id)).toEqual([])
  expect(await store.data(id)).toEqual(clearData ? { version: 0, value: {} } : expect.objectContaining({ version: 1 }))
})

it.each(['workbench', 'removeData', 'removePackages'] as const)('keeps the installation retryable after %s cleanup fails', async (operation) => {
  let fail = true
  const { store, service } = await fixture({ workbench: async event => operation === 'workbench' && fail ? null : event.requestId })
  await store.saveData('tests.reader', { retained: true }, 1)
  if (operation !== 'workbench')
    vi.spyOn(store, operation).mockRejectedValueOnce(new Error('fixture permission denied'))
  await expect(service.uninstall('tests.reader', true)).rejects.toThrow(operation === 'workbench' ? 'EXTENSION_DATA_CLEANUP_FAILED' : 'fixture permission denied')
  expect((await service.list())[0]).toMatchObject({ enabled: false, state: 'disabled' })
  if (operation !== 'removePackages')
    expect(await store.data('tests.reader')).toEqual({ version: 1, value: { retained: true } })
  fail = false
  await service.uninstall('tests.reader', true)
  expect(await service.list()).toEqual([])
  expect(await store.data('tests.reader')).toEqual({ version: 0, value: {} })
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
  allowed = false
  await expect(hosts[0]!.broker('resources.readText', { id: command.resource.id })).rejects.toThrow('RESOURCE_REVOKED')
})

it('invalidates in-flight requests and old generation brokers on disable and crash', async () => {
  const pending = deferred<string>()
  let wait = false
  const { service, hosts } = await fixture({ readText: async () => wait ? pending.promise : 'Selected' })
  const reports: ApplicationDiagnostic[] = []
  const subscription = observeExtensionDiagnostics(service, report => reports.push(applicationDiagnosticSchema.parse(report)))
  cleanup.push(async () => subscription.dispose())
  expect((await service.list())[0]?.state).toBe('inactive')
  expect(hosts).toHaveLength(0)
  await Promise.all([service.execute('tests.reader', 'tests.reader.open', target), service.execute('tests.reader', 'tests.reader.open', target)])
  expect(hosts).toHaveLength(1)
  expect(hosts[0]!.commands).toHaveLength(2)
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
  const generation = (await service.list())[0]!.generation
  const previous = hosts.at(-1)!
  await service.resetHosts()
  await expect(previous.broker('storage.set', { value: {}, version: 1 })).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await service.execute('tests.reader', 'tests.reader.open', null)
  expect((await service.list())[0]!.generation).not.toBe(generation)
  hosts.at(-1)!.failed({ code: 'EXTENSION_REQUEST_TIMEOUT', method: 'command', stage: 'timeout' })
  expect(await service.inspect('tests.reader')).toMatchObject({ state: 'failed', error: 'EXTENSION_REQUEST_TIMEOUT' })
  expect(reports.filter(report => report.event === 'extensions.host.failed' && report.errorCode === 'EXTENSION_REQUEST_TIMEOUT')).toEqual([
    expect.objectContaining({ extensionRequest: { method: 'command', stage: 'timeout' } }),
  ])
})

it('binds every view to its token and resource, and acknowledges only persisted state', async () => {
  let failSave = false
  const { service, hosts, events } = await fixture({ workbench: async (event) => {
    if (failSave)
      return null
    events.push(event)
    return event.kind === 'state' ? event.viewId : null
  } })
  await service.execute('tests.reader', 'tests.reader.open', target)
  const resource = (hosts[0]!.commands[0] as { resource: { id: string, name: string } }).resource
  const input = { viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource, state: { position: 3 }, stateVersion: 1 }
  await expect(service.openView({ ...input, resource: null })).rejects.toThrow('EXTENSION_RESOURCE_REQUIRED')
  const first = await service.openView(input)
  const second = await service.openView(input)
  service.closeView(first.id, first.generation, first.token)
  await expect(service.viewRequest(first.id, first.generation, first.token, 'bootstrap', null)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  expect(await service.viewRequest(second.id, second.generation, second.token, 'bootstrap', null)).toMatchObject({ state: { position: 3 } })
  await expect(service.viewRequest(second.id, second.generation, second.token, 'resources.readText', { id: randomUUID() })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(service.viewRequest(second.id, second.generation, second.token, 'storage.get', null)).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await service.viewRequest(second.id, second.generation, second.token, 'view.setState', { position: 9 })
  expect(events).toContainEqual(expect.objectContaining({ kind: 'state', viewId: second.id, generation: second.generation, token: second.token, state: { position: 9 } }))
  failSave = true
  await expect(service.viewRequest(second.id, second.generation, second.token, 'view.setState', { position: 10 })).rejects.toThrow('EXTENSION_STATE_SAVE_FAILED')
  expect(await service.viewRequest(second.id, second.generation, second.token, 'bootstrap', null)).toMatchObject({ state: { position: 9 } })
  await service.enable('tests.reader', false)
  await expect(service.viewRequest(second.id, second.generation, second.token, 'bootstrap', null)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
})

it('keeps pending versions and permissions inactive across restarts and incompatible updates until applied', async () => {
  const get = vi.fn(async () => new Response('allowed'))
  const { root, store, service, hosts } = await fixture({ get })
  await service.execute('tests.reader', 'tests.reader.open', null)
  await expect(service.applyUpdate('tests.reader')).rejects.toThrow('EXTENSION_UPDATE_UNAVAILABLE')
  expect(hosts[0]!.disposed).toBe(false)
  const update = await reviewPackage(root, store, manifest({ version: '1.1.0', permissions: { selectedResource: 'read', network: ['https://example.com'] } }))
  await service.install(update.token)
  await expect(hosts[0]!.broker('network.get', { url: 'https://example.com/' })).rejects.toThrow('EXTENSION_NETWORK_DENIED')
  expect(get).not.toHaveBeenCalled()
  await service.restart('tests.reader')
  await service.execute('tests.reader', 'tests.reader.open', null)
  expect((await service.list())[0]).toMatchObject({ manifest: { version: '1.0.0' }, pending: { manifest: { version: '1.1.0' } } })
  expect(hosts[0]!.disposed).toBe(true)
  await expect(hosts[0]!.broker('storage.get', {})).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await expect(hosts[1]!.broker('network.get', { url: 'https://example.com/' })).rejects.toThrow('EXTENSION_NETWORK_DENIED')
  const generation = (await service.list())[0]!.generation
  const pending = store.installed['tests.reader']!.pending!
  const range = pending.manifest.engines.lexora
  pending.manifest.engines.lexora = '>=9.0.0'
  await expect(service.applyUpdate('tests.reader')).rejects.toMatchObject({ review: { incompatibility: { reason: 'app-too-old' } } })
  await service.execute('tests.reader', 'tests.reader.open', null)
  expect((await service.list())[0]).toMatchObject({ state: 'active', generation, manifest: { version: '1.0.0' }, pending: { manifest: { version: '1.1.0' }, incompatibility: { reason: 'app-too-old' } } })
  pending.manifest.engines.lexora = range
  await service.applyUpdate('tests.reader')
  expect((await service.list())[0]).toMatchObject({ manifest: { version: '1.1.0' }, pending: null })
  expect(hosts[1]!.disposed).toBe(true)
  await expect(hosts[1]!.broker('storage.get', {})).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await service.execute('tests.reader', 'tests.reader.open', null)
  expect(await hosts[2]!.broker('network.get', { url: 'https://example.com/' })).toEqual({ status: 200, text: 'allowed', headers: {} })
  get.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://unapproved.example/' } }))
  await expect(hosts[2]!.broker('network.get', { url: 'https://example.com/' })).rejects.toThrow('EXTENSION_NETWORK_DENIED')
})

it.each([1, 4] as const)('returns bounded final-response Link metadata through host and view clients on API %s without granting URLs', async (apiVersion) => {
  const link = '<https://unapproved.example/models?cursor=next%2Fpage>; rel="next", <https://example.com/models>; rel="first"'
  const urls: string[] = []
  const get: ExtensionServicePorts['get'] = async (url) => {
    urls.push(url)
    if (url.endsWith('/redirect'))
      return new Response(null, { status: 302, headers: { Location: '/models', Link: '<https://example.com/incorrect>; rel="next"' } })
    return new Response('[]', { headers: { 'Link': link, 'Set-Cookie': 'fixture=private', 'Cookie': 'fixture=private', 'Authorization': 'Bearer fixture', 'X-Private': 'private' } })
  }
  const value = manifest({ apiVersion, permissions: { network: ['https://example.com'] }, contributes: {
    commands: [{ id: 'tests.reader.open', title: 'Open' }],
    views: [{ id: 'tests.reader.reader', title: 'Reader', entry: 'view.js', resource: 'none' }],
  } })
  const { service, hosts } = await fixture({ get }, value)
  await service.execute('tests.reader', 'tests.reader.open', null)
  const broker = hosts[0]!.broker
  const client = createExtensionNetworkClient(broker)
  const result = await client.get('https://example.com/redirect')
  expect(result).toEqual({ status: 200, text: '[]', headers: { link } })
  expect(urls).toEqual(['https://example.com/redirect', 'https://example.com/models'])
  await expect(client.get('https://unapproved.example/models?cursor=next%2Fpage')).rejects.toThrow('EXTENSION_NETWORK_DENIED')
  await expect(client.get('http://example.com/models')).rejects.toThrow('EXTENSION_NETWORK_DENIED')
  await expect(broker('network.get', { url: 'https://example.com/models', headers: { Authorization: 'Bearer fixture' } })).rejects.toThrow()
  expect(urls).toHaveLength(2)
  const view = await service.openView({ viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource: null, state: null, stateVersion: 1 })
  const viewClient = createExtensionNetworkClient((method, params) => service.viewRequest(view.id, view.generation, view.token, method, params))
  expect(await viewClient.get('https://example.com/models')).toEqual(result)
})

it('fails explicitly on oversized Link metadata without changing the text response budget', async () => {
  let oversizedBody = false
  const { service, hosts } = await fixture({ get: async () => oversizedBody
    ? new Response('a'.repeat(1024 * 1024 + 1))
    : new Response('[]', { headers: { Link: 'a'.repeat(EXTENSION_NETWORK_LINK_BYTES_LIMIT + 1) } }) }, manifest({ permissions: { selectedResource: 'read', network: ['https://example.com'] } }))
  await service.execute('tests.reader', 'tests.reader.open', null)
  const client = createExtensionNetworkClient(hosts[0]!.broker)
  await expect(client.get('https://example.com/models')).rejects.toThrow('EXTENSION_NETWORK_HEADERS_TOO_LARGE')
  oversizedBody = true
  await expect(client.get('https://example.com/models')).rejects.toThrow('WEB_RESPONSE_TOO_LARGE')
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
    return event.kind === 'control' ? event.viewId : event.kind === 'placement' ? event.requestId : randomUUID()
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
  await expect(service.viewRequest(ordinary.id, ordinary.generation, ordinary.token, 'view.setPresentation', { height: 260 })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await hosts[0]!.broker('placements.show', { id: 'tests.controls.top' })
  expect(events).toContainEqual(expect.objectContaining({ kind: 'placement', extensionId: value.id, placementId: 'tests.controls.top', visible: true }))
  await expect(hosts[0]!.broker('placements.show', { id: 'tests.controls.top', instanceId: randomUUID() })).rejects.toThrow('EXTENSION_PLACEMENT_UNAVAILABLE')
  await hosts[0]!.broker('placements.show', { id: 'tests.controls.reasoning' })
  expect(events).toContainEqual(expect.objectContaining({ kind: 'placement', placementId: 'tests.controls.reasoning', visible: true }))
  await expect(hosts[0]!.broker('placements.show', { id: 'tests.controls.reasoning', instanceId: randomUUID() })).rejects.toThrow('EXTENSION_PLACEMENT_UNAVAILABLE')
  await expect(service.viewRequest(ordinary.id, ordinary.generation, ordinary.token, 'view.setActive', { active: false })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(hosts[0]!.broker('placements.show', { id: 'another.plugin.top' })).rejects.toThrow('EXTENSION_PLACEMENT_UNAVAILABLE')
  await service.enable(value.id, false)
  await expect(service.viewRequest(session.id, session.generation, session.token, 'control.propose', proposal)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
})

it('authorizes slot activation and withdrawal without expanding layout or control permissions', async () => {
  const { root, store, service, hosts, events } = await fixture()
  const value = manifest({ apiVersion: 3, id: 'tests.footer', contributes: {
    views: [{ id: 'tests.footer.content', title: 'Footer', entry: 'view.js', resource: 'none' }],
    placements: [{ id: 'tests.footer.slot', view: 'tests.footer.content', kind: 'slot', target: 'composer.footer' }],
  } })
  await service.install((await reviewPackage(root, store, value)).token)
  const session = await service.openView({ viewId: randomUUID(), extensionId: value.id, viewType: 'tests.footer.content', placementId: 'tests.footer.slot', resource: null, state: null, stateVersion: 0 })
  const request = (method: string, params: JsonValue) => service.viewRequest(session.id, session.generation, session.token, method, params)
  expect(await request('bootstrap', null)).toMatchObject({ presentation: 'slot' })
  await expect(request('view.setState', {})).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(request('view.setPresentation', { height: 200 })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(request('control.propose', { revision: randomUUID(), value: 'high' })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await hosts[0]!.broker('placements.show', { id: 'tests.footer.slot' })
  await hosts[0]!.broker('placements.hide', { id: 'tests.footer.slot' })
  expect(events).toContainEqual(expect.objectContaining({ kind: 'placement', placementId: 'tests.footer.slot', visible: false }))
  await request('view.setActive', { active: false })
  expect(events).toContainEqual(expect.objectContaining({ kind: 'activity', viewId: session.id, token: session.token, active: false }))
  await request('view.setActive', { active: true })
  await expect(request('view.setActive', { active: 'yes' })).rejects.toThrow()
  await expect(service.viewRequest(session.id, session.generation, randomUUID(), 'view.setActive', { active: false })).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await expect(hosts[0]!.broker('placements.hide', { id: 'tests.footer.slot', interactionId: randomUUID() })).rejects.toThrow('EXTENSION_PLACEMENT_UNAVAILABLE')
  await service.enable(value.id, false)
  await expect(request('view.setActive', { active: true })).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
})

it('does not let an older concurrent open replace a newer view endpoint', async () => {
  const { store, service } = await fixture()
  const resource = await store.grant('tests.reader', target)
  const original = store.resolveFileOpeningGrant.bind(store)
  const pending = deferred<{ kind: 'space', target: typeof target }>()
  const entered = deferred<void>()
  let requests = 0
  vi.spyOn(store, 'resolveFileOpeningGrant').mockImplementation(async (...args) => {
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
  pending.resolve({ kind: 'space', target })
  await rejected
  expect(await service.viewRequest(current.id, current.generation, current.token, 'bootstrap', null)).toMatchObject({ state: { restored: true } })
})

it('records a failed view without failing its host or other views', async () => {
  const { store, service } = await fixture()
  const resource = await store.grant('tests.reader', target)
  const input = { viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource, state: { secret: 'private-state' }, stateVersion: 1 }
  const failed = await service.openView(input)
  const retained = await service.openView({ ...input, viewId: randomUUID() })
  await service.viewRequest(failed.id, failed.generation, failed.token, 'view.failed', { code: 'EXTENSION_VIEW_TIMEOUT' })
  service.closeView(failed.id, failed.generation, failed.token)
  const status = await service.inspect('tests.reader')
  expect(status).toMatchObject({ state: 'active', error: null })
  expect(JSON.stringify(status)).not.toContain('private-state')
  expect(status.logs.at(-1)).toMatchObject({ event: 'view.failed', code: 'EXTENSION_VIEW_TIMEOUT' })
  expect(await service.viewRequest(retained.id, retained.generation, retained.token, 'bootstrap', null)).toMatchObject({ state: { secret: 'private-state' } })
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
  const current = await f.service.openView({ ...input, viewId: randomUUID() })
  const request = (method: string, params: JsonValue) => f.service.viewRequest(current.id, current.generation, current.token, method, params)
  const [picked] = await request('resources.pickFiles', {}) as { id: string }[]
  const copy = await request('resources.importFile', { id: randomUUID(), resourceId: picked!.id, name: 'copy.mp3' }) as { id: string }
  await request('resources.revokeFile', { id: picked!.id })
  expect(await request('resources.readText', { id: copy.id })).toBe('media bytes')
  expect(await readFile(path, 'utf8')).toBe('media bytes')
  const [foreign] = await f.store.resources.grant('tests.reader', [path], () => {})
  await expect(request('resources.importFile', { id: randomUUID(), resourceId: foreign!.id })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  const resource = await f.store.grant('tests.reader', target)
  const denied = await f.service.openView({ ...input, viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource })
  expect(await f.service.viewRequest(denied.id, denied.generation, denied.token, 'resources.listFiles', null)).toEqual([])
})

it('keeps export permission separate from reads and expires writers with their owning view', async () => {
  let destination = ''
  const value = manifest({ apiVersion: 2, id: 'tests.export', permissions: { localResources: true }, contributes: { views: [{ id: 'tests.export.page', title: 'Export', entry: 'view.js', resource: 'none' }] } })
  const f = await fixture({ selectSavePath: async () => destination }, value)
  destination = join(f.root, 'export.binary')
  await writeFile(destination, 'original')
  const input = { viewId: randomUUID(), extensionId: value.id, viewType: 'tests.export.page', resource: null, state: null, stateVersion: 1 }
  const readOnly = await f.service.openView(input)
  const payload = { name: 'file.unknown', size: 4 }
  await expect(f.service.viewRequest(readOnly.id, readOnly.generation, readOnly.token, 'resources.beginSave', payload)).rejects.toThrow('EXTENSION_RESOURCE_EXPORT_DENIED')
  await f.service.install((await reviewPackage(f.root, f.store, manifest({ ...value, version: '1.1.0', permissions: { resourceExport: true } }))).token)
  await f.service.applyUpdate(value.id)
  const owner = await f.service.openView(input)
  const other = await f.service.openView({ ...input, viewId: randomUUID() })
  const request = (method: string, params: JsonValue) => f.service.viewRequest(owner.id, owner.generation, owner.token, method, params)
  expect(await request('resources.listFiles', null)).toEqual([])
  const id = await request('resources.beginSave', payload)
  await expect(f.service.viewRequest(other.id, other.generation, other.token, 'resources.commitSave', { id })).rejects.toThrow('EXTENSION_RESOURCE_WRITE_EXPIRED')
  await request('resources.writeChunk', { id, offset: 0, base64: Buffer.from('new!').toString('base64') })
  f.service.closeView(owner.id, owner.generation, owner.token)
  await expect(request('resources.commitSave', { id })).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await f.service.dispose()
  expect((await readdir(f.root)).filter(name => name.startsWith('.lexora-'))).toEqual([])
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
  const nextId = randomUUID()
  await f.broker('interactions.start', { id: nextId, title: 'Game' })
  const nextView = await f.service.openView({ ...f.input, interactionId: nextId })
  await f.service.enable('tests.game', false)
  await expect(f.service.viewRequest(nextView.id, nextView.generation, nextView.token, 'bootstrap', null)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  expect(f.events).toContainEqual(expect.objectContaining({ kind: 'interaction', interactionId: nextId, title: null }))
})

it('routes same-name commands independently and keeps the other plugin available after disable', async () => {
  const f = await interactionFixture()
  const value = manifest({ id: 'other.game', apiVersion: 3, contributes: { commands: [{ id: 'other.game.start', title: 'Start', slash: { name: 'game-start' } }] } })
  await f.service.install((await reviewPackage(f.root, f.store, value)).token)
  await f.service.executeSlash(value.id, 'other.game.start', 'second')
  await f.service.executeSlash('tests.game', 'tests.game.start', 'first')
  expect((await f.service.list()).filter(item => item.state === 'active').map(item => item.manifest.id).sort()).toEqual(['other.game', 'tests.game'])
  expect(f.hosts[0]!.commands.at(-1)).toMatchObject({ command: 'tests.game.start', arguments: 'first' })
  expect(f.hosts[1]!.commands.at(-1)).toMatchObject({ command: 'other.game.start', arguments: 'second' })
  await f.service.enable('tests.game', false)
  await f.service.executeSlash(value.id, 'other.game.start', 'still available')
  expect(f.hosts[1]!.commands.at(-1)).toMatchObject({ arguments: 'still available' })
})

it.each([false, true])('requires theme management permission and revokes host-owned previews on disable: %s', async (themeManagement) => {
  const home = await createTemporaryDirectory('lexora-theme-permission-')
  const themes = new ThemeService(home, async () => {})
  await themes.initialize(DEFAULT_THEME_PREFERENCE, false)
  cleanup.push(() => themes.dispose())
  const f = await fixture({ themes }, manifest({ apiVersion: 3, permissions: { selectedResource: 'read', themeManagement } }))
  await f.service.execute('tests.reader', 'tests.reader.open', null)
  const broker = f.hosts[0]!.broker
  expect(await broker('themes.request', { action: 'active' })).toMatchObject({ preview: false })
  const input = { action: 'beginPreview', archive: { schemaVersion: 1, appearance: 'light', label: 'Preview', document: { schemaVersion: 1 } } }
  if (!themeManagement) {
    await expect(broker('themes.request', input)).rejects.toThrow('EXTENSION_PERMISSION_DENIED')
    expect(themes.snapshot.preview).toBe(false)
  }
  else {
    await broker('themes.request', input)
    expect(themes.snapshot.preview).toBe(true)
    await f.service.enable('tests.reader', false)
    expect(themes.snapshot.preview).toBe(false)
    await expect(broker('themes.request', input)).rejects.toThrow('EXTENSION_HOST_STOPPED')
  }
})

it.each([false, true])('owns window styles behind the effects permission and resolves only owned resources: %s', async (windowEffects) => {
  const value = manifest({ apiVersion: 3, permissions: { windowEffects, selectedResource: 'read', network: ['https://media.example.com'] } })
  const f = await fixture({ get: async () => new Response('image', { headers: { 'content-type': 'image/png' } }) }, value)
  await f.service.execute(value.id, 'tests.reader.open', null)
  const broker = f.hosts[0]!.broker
  if (!windowEffects) {
    await expect(broker('window.styles.set', { id: 'wallpaper', css: ':root { --custom-accent: red; }' })).rejects.toThrow('EXTENSION_PERMISSION_DENIED')
    await expect(broker('window.styles.remove', { id: 'wallpaper' })).rejects.toThrow('EXTENSION_PERMISSION_DENIED')
    return
  }
  const file = await broker('network.download', { id: randomUUID(), url: 'https://media.example.com/image.png' }) as { id: string }
  const url = await broker('resources.getUrl', { id: file.id })
  await expect(broker('resources.getUrl', { id: randomUUID() })).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await expect(broker('resources.getUrl', { packagePath: '../private.png' })).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  await expect(broker('resources.getUrl', { packagePath: 'missing.png' })).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  const input = { id: 'wallpaper', css: `body::before { background-image: url("${url}"); }` }
  const current = async () => (await f.service.list())[0]!.windowStyles
  await broker('window.styles.set', input)
  await broker('window.styles.set', { id: 'controls', css: 'button:hover { border-radius: 2rem; } @media (width < 800px) { button { padding: 2px; } }' })
  await broker('window.styles.set', { ...input, css: ':root { --custom-accent: red; }' })
  expect(await current()).toEqual([{ id: 'wallpaper', css: ':root { --custom-accent: red; }' }, { id: 'controls', css: expect.stringContaining('@media') }])
  await expect(broker('window.styles.set', { id: '', css: '' })).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  await broker('window.styles.remove', { id: 'wallpaper' })
  expect(await current()).toEqual([{ id: 'controls', css: expect.any(String) }])
  await broker('resources.release', { id: file.id })
  await expect(broker('resources.getUrl', { id: file.id })).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  const gate = deferred<Awaited<ReturnType<typeof f.store.resources.list>>>()
  vi.spyOn(f.store.resources, 'list').mockReturnValueOnce(gate.promise)
  const resolving = broker('resources.getUrl', { id: file.id })
  const rejected = expect(resolving).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await f.service.enable(value.id, false)
  gate.resolve([{ id: file.id, name: 'next.png', size: 5, mimeType: 'image/png' }])
  await rejected
  expect(await current()).toEqual([])
  await expect(broker('window.styles.set', input)).rejects.toThrow('EXTENSION_HOST_STOPPED')
})

it('reports host and view validation failures with bounded, redacted diagnostics', async () => {
  const home = await createTemporaryDirectory('lexora-theme-diagnostic-')
  const themes = new ThemeService(home, async () => {})
  await themes.initialize(DEFAULT_THEME_PREFERENCE, false)
  cleanup.push(() => themes.dispose())
  const value = manifest({ apiVersion: 3, permissions: { themeManagement: true }, contributes: { commands: [{ id: 'tests.reader.open', title: 'Open' }], views: [{ id: 'tests.reader.reader', title: 'Reader', entry: 'view.js', resource: 'none' }] } })
  const { service, hosts } = await fixture({ themes }, value)
  const reports: ApplicationDiagnostic[] = []
  const unsubscribe = observeExtensionDiagnostics(service, report => reports.push(applicationDiagnosticSchema.parse(report)))
  cleanup.push(async () => unsubscribe.dispose())
  await service.execute(value.id, 'tests.reader.open', null)
  const view = await service.openView({ viewId: randomUUID(), extensionId: value.id, viewType: 'tests.reader.reader', resource: null, state: null, stateVersion: 1 })
  const request = (method: string, params: unknown) => service.viewRequest(view.id, view.generation, view.token, method, params)
  const input = { action: 'save', archive: { schemaVersion: 1, appearance: 'light', label: 'Private label', document: { schemaVersion: 1, materials: [{ anchor: 'workbench.pane', blur: 99 }] } } }
  for (const send of [hosts[0]!.broker, request]) {
    await expect(send('themes.request', input)).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
    const status = extensionInspectionSchema.parse(await service.inspect(value.id))
    expect(status).toMatchObject({ state: 'active', error: null })
    expect(status.logs.at(-1)).toMatchObject({ event: 'request.failed', code: 'EXTENSION_INVALID_ARGUMENT', diagnostic: { method: 'themes.request', stage: 'validation', issues: [{ path: 'archive.document.materials.0.blur', code: 'too_big' }] } })
  }
  expect(reports).toContainEqual(expect.objectContaining({ event: 'extensions.request.failed', errorCode: 'EXTENSION_INVALID_ARGUMENT', extensionRequest: expect.objectContaining({ stage: 'validation' }) }))
  const colors = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`private-key-${index}`, 'private-value']))
  await expect(request('themes.request', { action: 'resolve', appearance: 'light', document: { schemaVersion: 1 }, overrides: colors })).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  const diagnostic = (await service.inspect(value.id)).logs.at(-1)!.diagnostic!
  expect(diagnostic.issues).toHaveLength(8)
  expect(diagnostic.issues!.every(issue => issue.path === 'overrides.*')).toBe(true)
  const before = (await service.inspect(value.id)).logs
  await expect(service.viewRequest(view.id, view.generation, randomUUID(), 'themes.request', input)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  expect((await service.inspect(value.id)).logs).toEqual(before)
  await expect(request('private-method', null)).rejects.toThrow('EXTENSION_METHOD_DENIED')
  expect((await service.inspect(value.id)).logs.at(-1)!.diagnostic).toEqual({ method: 'unknown', stage: 'execution' })
  expect(JSON.stringify({ reports, inspection: await service.inspect(value.id) })).not.toContain('private-')
  expect(JSON.stringify(reports)).not.toContain('Private label')
})

it('downloads files and saves standalone theme images using existing grants without another picker', async () => {
  const home = await createTemporaryDirectory('lexora-media-theme-')
  const themes = new ThemeService(home, async () => {})
  await themes.initialize(DEFAULT_THEME_PREFERENCE, false)
  cleanup.push(() => themes.dispose())
  const opened: string[] = []
  const value = manifest({ apiVersion: 3, permissions: { network: ['https://media.example.com'], themeManagement: true }, contributes: {
    commands: [{ id: 'tests.reader.open', title: 'Open' }],
    views: [{ id: 'tests.reader.reader', title: 'Media', entry: 'view.js', resource: 'none' }],
  } })
  const f = await fixture({ themes, get: async () => new Response(Buffer.alloc(8 * 1024 * 1024, 42), { headers: { 'content-type': 'image/png' } }), openExternal: async (url) => {
    opened.push(url)
  } }, value)
  const view = await f.service.openView({ viewId: randomUUID(), extensionId: value.id, viewType: 'tests.reader.reader', resource: null, state: {}, stateVersion: 1 })
  const request = (method: string, params: JsonValue) => f.service.viewRequest(view.id, view.generation, view.token, method, params)
  const resource = await request('network.download', { id: randomUUID(), url: 'https://media.example.com/wallpaper.png' }) as { id: string, size: number }
  expect(resource.size).toBe(8 * 1024 * 1024)
  const saved = await f.hosts[0]!.broker('themes.request', { action: 'save', archive: { schemaVersion: 1, appearance: 'dark', label: 'Media', document: { schemaVersion: 1, welcome: { image: 'wallpaper.png' } }, assets: { 'wallpaper.png': { resourceId: resource.id } } } }) as { id: string }
  await request('resources.release', { id: resource.id })
  await request('themes.request', { action: 'preference', preference: { id: saved.id } })
  const url = themes.snapshot.active.assets['wallpaper.png']!
  expect([...new Uint8Array(await (await themes.assetResponse(new Request(url, { headers: { range: 'bytes=0-2' } }))).arrayBuffer())]).toEqual([42, 42, 42])
  await request('links.openExternal', { url: 'https://media.example.com/source#credits' })
  expect(opened).toEqual(['https://media.example.com/source#credits'])
  await expect(request('links.openExternal', { url: 'https://other.example.com/' })).rejects.toThrow('EXTENSION_NETWORK_DENIED')
})

async function inferenceResourceFixture(overrides: Partial<ExtensionServicePorts> = {}) {
  const f = await fixture({
    inference: { sandbox: '', executable: '', bootstrap: '', admit: async () => async () => {} },
    ...overrides,
  }, manifest({
    apiVersion: 4,
    permissions: { inference: true, localResources: true, network: ['https://media.example.com'] },
    contributes: {
      views: [{ id: 'tests.reader.reader', title: 'Models', entry: 'view.js', resource: 'none' }],
      inference: {
        runtimes: [{ id: 'local', entry: 'native/fixture.mjs', platforms: ['linux-x64'], capacity: 1, idleTimeoutMs: 60000 }],
        capabilities: [{ id: 'local', title: 'Local', kind: 'speech.transcribe', runtime: 'local' }],
      },
    },
  }), { 'native/fixture.mjs': 'export function initialize() {}' })
  const view = await f.service.openView({ viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource: null, state: null, stateVersion: 1 })
  return {
    ...f,
    host: (method: string, params: JsonValue = null) => f.hosts[0]!.broker(method, params),
    view: (method: string, params: JsonValue = null) => f.service.viewRequest(view.id, view.generation, view.token, method, params),
  }
}

it('resumes through the public resource transport and reauthorizes every redirect without discarding owned partials', async () => {
  const requests: Array<{ url: string, headers?: Record<string, string> }> = []
  let attempt = 0
  const f = await inferenceResourceFixture({ get: async (url, init) => {
    requests.push({ url, headers: init.headers })
    if (attempt === 0) {
      let pulled = false
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled) {
            controller.error(new Error('connection reset'))
          }
          else {
            pulled = true
            controller.enqueue(Buffer.from('wei'))
          }
        },
      }, { highWaterMark: 0 }), { headers: { 'content-length': '7', 'etag': '"v1"' } })
    }
    if (url.endsWith('/model'))
      return new Response(null, { status: 302, headers: { location: attempt === 1 ? 'https://unauthorized.example/model' : 'https://media.example.com/blob' } })
    return new Response('ghts', { status: 206, headers: { 'content-range': 'bytes 3-6/7', 'content-length': '4', 'etag': '"v1"' } })
  } })
  const resource = { id: 'model', kind: 'model', files: [{ path: 'model.bin', sha256: createHash('sha256').update('weights').digest('hex'), size: 7, source: { url: 'https://media.example.com/model' } }] }
  const prepare = () => f.host('inference.resources.prepare', { id: randomUUID(), resource })
  await expect(prepare()).rejects.toThrow('DOWNLOAD_FAILED')
  attempt = 1
  await expect(prepare()).rejects.toThrow('EXTENSION_NETWORK_DENIED')
  expect(requests.map(request => request.url)).toEqual(['https://media.example.com/model', 'https://media.example.com/model'])
  attempt = 2
  await expect(prepare()).resolves.toMatchObject({ id: 'model', bytes: 7 })
  expect(requests[0]!.headers).toEqual({ 'accept-encoding': 'identity' })
  expect(requests.slice(1).every(request => request.headers?.range === 'bytes=3-' && request.headers['if-range'] === '"v1"')).toBe(true)
  expect(requests.at(-1)!.url).toBe('https://media.example.com/blob')
  for (const url of ['http://media.example.com/model', 'https://unauthorized.example/model', 'https://media.example.com:444/model', 'https://127.0.0.1/model']) {
    await expect(f.host('inference.resources.prepare', {
      id: randomUUID(),
      resource: { ...resource, files: [{ ...resource.files[0]!, source: { url } }] },
    })).rejects.toThrow(/EXTENSION_NETWORK_DENIED|WEB_URL_BLOCKED/)
  }
  expect(requests).toHaveLength(4)
})

it.each(['ready', 'checksum'] as const)('delivers resource progress before %s settlement under backpressure and detaches the settled callback', async (ending) => {
  const events = new ExtensionHostEvents()
  cleanup.push(async () => events.dispose())
  const release = deferred<void>()
  cleanup.push(async () => release.resolve())
  const prepared = deferred<void>()
  let request!: (method: string, params?: JsonValue) => Promise<JsonValue>
  let first = true
  let operationId = ''
  const f = await inferenceResourceFixture({
    get: async () => new Response('weights'),
    createHost: (_pkg, broker) => {
      request = (method, params = null) => broker(method, params)
      return { call: async (method, params) => {
        if (method === 'inference.progress') {
          const event = params as unknown as InferenceResourceEvents['inference:resources:progress']
          operationId = event.id
          events.inferenceProgress(event)
          if (first) {
            first = false
            await release.promise
          }
        }
        return null
      }, dispose: async () => {}, devtools: () => {} }
    },
  })
  const prepare = f.store.inference.prepare.bind(f.store.inference)
  vi.spyOn(f.store.inference, 'prepare').mockImplementation(async (...args) => {
    try {
      return await prepare(...args)
    }
    finally { prepared.resolve() }
  })
  const client = createExtensionInferenceClient(request, events.events)
  const progress: InferenceResourceProgress[] = []
  const hash = createHash('sha256').update('weights').digest('hex')
  const pending = client.resources.prepare({ id: 'model', kind: 'model', files: [
    { path: 'first.bin', sha256: hash, size: 7, source: { url: 'https://media.example.com/first' } },
    { path: 'second.bin', sha256: ending === 'checksum' ? '0'.repeat(64) : hash, source: { url: 'https://media.example.com/second' } },
  ] }, { onProgress: value => progress.push(value) })
  const settled = ending === 'ready' ? expect(pending).resolves.toMatchObject({ files: 2, bytes: 14 }) : expect(pending).rejects.toThrow('CHECKSUM_MISMATCH')
  await prepared.promise
  expect(progress.map(value => value.phase)).toEqual(['connect'])
  events.inferenceProgress({ id: randomUUID(), progress: { ...progress[0]!, phase: 'ready' } })
  expect(progress).toHaveLength(1)
  release.resolve()
  await settled
  expect(progress.at(-1)).toMatchObject(ending === 'ready'
    ? { phase: 'ready', path: '', bytes: 14, completedFiles: 2, totalFiles: 2 }
    : { phase: 'verify', path: 'second.bin', bytes: 7, completedFiles: 1 })
  expect(await client.resources.list()).toHaveLength(ending === 'ready' ? 1 : 0)
  const count = progress.length
  events.inferenceProgress({ id: operationId, progress: progress[0]! })
  expect(progress).toHaveLength(count)
})

it.each(['host', 'view'] as const)('keeps downloads, inference and original grants alive across concurrent private releases from %s', async (owner) => {
  const downloadStarted = deferred<void>()
  const finishDownload = deferred<void>()
  const downloadAbort = new AbortController()
  const f = await inferenceResourceFixture({ get: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from('model ')) },
    async pull(controller) {
      downloadStarted.resolve()
      await finishDownload.promise
      controller.enqueue(Buffer.from('download'))
      controller.close()
    },
  })) })
  const resources = createExtensionResourceClient(f[owner])
  const original = join(f.root, 'original.bin')
  await writeFile(original, 'original weights')
  const [grant] = await f.store.resources.grant('tests.reader', [original], () => {})
  const temporary = await resources.importFile(grant!)
  const avatar = await resources.createFile({ name: 'avatar.bin', data: Buffer.from('avatar') })
  const model = await f.host('inference.resources.prepare', {
    id: randomUUID(),
    resource: { id: 'model', kind: 'model', files: [{ path: 'model.bin', sha256: createHash('sha256').update('original weights').digest('hex'), source: { resourceId: grant!.id, reference: true } }] },
  }) as InferenceResourceSet
  await f.host('inference.bind', { runtime: 'local', resources: [{ mount: 'model', id: model.id, revision: model.revision }] })
  const native = memoryInference()
  cleanup.push(async () => {
    native.close()
    await native.reading
  })
  vi.spyOn(NativeInferenceProcess, 'start').mockResolvedValue(native.worker)
  const ready = deferred<void>()
  const finishInference = deferred<void>()
  const events: unknown[] = []
  const call = f.service.invokeInference('tests.reader', f.store.installed['tests.reader']!.current.revision, invocation({
    id: randomUUID(),
    ready: () => {
      ready.resolve()
      return finishInference.promise
    },
    event(data, bytes) { events.push({ data, bytes: [...bytes] }) },
  }))
  void call.catch(() => {})
  const download = createExtensionNetworkClient(f[owner]).download('https://media.example.com/model.bin', { signal: downloadAbort.signal })
  void download.catch(() => {})
  cleanup.push(async () => {
    finishInference.resolve()
    finishDownload.resolve()
    downloadAbort.abort()
    await Promise.allSettled([call, download])
  })
  await Promise.all([ready.promise, downloadStarted.promise])
  const status = await f.host('inference.status')
  expect(status).toMatchObject([{ configured: true, instances: [{ id: native.worker.instanceId, state: 'ready', active: 1 }] }])
  const changes: string[] = []
  const subscription = f.service.onDidChange(change => changes.push(change.kind))
  cleanup.push(async () => subscription.dispose())
  await Promise.all([resources.release(temporary), resources.release(avatar), resources.release(grant!)])
  expect(await f.host('inference.status')).toEqual(status)
  expect(changes).not.toContain('inference-models')
  await expect(resources.readBytes(temporary)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await expect(resources.readBytes(avatar)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  expect(await resources.readText(grant!)).toBe('original weights')
  expect(await readFile(original, 'utf8')).toBe('original weights')
  finishDownload.resolve()
  const downloaded = await download
  expect(await resources.readText(downloaded)).toBe('model download')
  finishInference.resolve()
  await call
  expect(events).toEqual([{ data: { size: 0, input: {} }, bytes: [1, 2, 3, 4] }])
  expect(await f.host('inference.status')).toMatchObject([{ configured: true, instances: [{ id: native.worker.instanceId, state: 'ready', active: 0 }] }])
  await f.view('resources.revokeFile', { id: grant!.id })
  expect(native.worker.stopped).toBe(true)
  expect(await f.host('inference.status')).toMatchObject([{ instances: [] }])
  await expect(resources.readBytes(grant!)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  expect(await readFile(original, 'utf8')).toBe('original weights')
})

it.each(['host', 'view'] as const)('cancels only the released source during inference copying from %s and denies private references', async (owner) => {
  const f = await inferenceResourceFixture()
  const resources = createExtensionResourceClient(f[owner])
  const bytes = Buffer.alloc(512 * 1024, 7)
  const file = await resources.createFile({ name: 'model.bin', data: bytes })
  const resource = { id: 'model', kind: 'model', files: [{ path: 'model.bin', sha256: createHash('sha256').update(bytes).digest('hex'), source: { resourceId: file.id, reference: true } }] }
  await expect(f.host('inference.resources.prepare', { id: randomUUID(), resource })).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  const started = deferred<void>()
  const resume = deferred<void>()
  const response = f.store.resources.response.bind(f.store.resources)
  vi.spyOn(f.store.resources, 'response').mockImplementationOnce(async (...args) => {
    const result = await response(...args)
    started.resolve()
    await resume.promise
    return result
  })
  const preparing = f.host('inference.resources.prepare', { id: randomUUID(), resource: { ...resource, files: [{ ...resource.files[0]!, source: { resourceId: file.id } }] } })
  const rejected = expect(preparing).rejects.toThrow('EXTENSION_RESOURCE_REVOKED')
  cleanup.push(async () => {
    resume.resolve()
    await Promise.allSettled([preparing])
  })
  await started.promise
  await resources.release(file)
  resume.resolve()
  await rejected
  expect(await f.host('inference.resources.list')).toEqual([])
  await expect(resources.readBytes(file)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  expect(await resources.listFiles()).toEqual([])
})

it('revalidates download redirects and cancels work owned by a closed view without retaining partial files', async () => {
  const started = deferred<void>()
  let redirect = true
  const f = await fixture({ get: async () => {
    if (redirect)
      return new Response(null, { status: 302, headers: { location: 'https://unapproved.example.com/image.png' } })
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(64 * 1024)) },
      pull() { started.resolve() },
    }))
  } }, manifest({ apiVersion: 3, permissions: { network: ['https://media.example.com'] }, contributes: { views: [{ id: 'tests.reader.reader', title: 'Media', entry: 'view.js', resource: 'none' }] } }))
  const input = { viewId: randomUUID(), extensionId: 'tests.reader', viewType: 'tests.reader.reader', resource: null, state: {}, stateVersion: 1 }
  const view = await f.service.openView(input)
  const other = await f.service.openView({ ...input, viewId: randomUUID() })
  const request = (method: string, params: JsonValue) => f.service.viewRequest(view.id, view.generation, view.token, method, params)
  await expect(request('network.download', { id: randomUUID(), url: 'https://media.example.com/image.png' })).rejects.toThrow('EXTENSION_NETWORK_DENIED')
  redirect = false
  const id = randomUUID()
  const pending = request('network.download', { id, url: 'https://media.example.com/large.mp4' })
  const rejected = expect(pending).rejects.toThrow()
  await started.promise
  await expect(f.service.viewRequest(other.id, other.generation, other.token, 'network.cancel', { id })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  f.service.closeView(view.id, view.generation, view.token)
  await rejected
  expect(await f.store.resources.list('tests.reader', false)).toEqual([])
})

it('creates private files through the SDK without export permission and isolates uploads by view and generation', async () => {
  const value = manifest({ apiVersion: 4, id: 'tests.generated', permissions: {}, contributes: { views: [{ id: 'tests.generated.page', title: 'Files', entry: 'view.js', resource: 'none' }] } })
  const f = await fixture({}, value)
  const input = { viewId: randomUUID(), extensionId: value.id, viewType: 'tests.generated.page', resource: null, state: null, stateVersion: 1 }
  const owner = await f.service.openView(input)
  const other = await f.service.openView({ ...input, viewId: randomUUID() })
  const request = (method: string, params: JsonValue = null) => f.service.viewRequest(owner.id, owner.generation, owner.token, method, params)
  const resources = createExtensionResourceClient(request)
  const bytes = new Uint8Array(240 * 1024).map((_, index) => index % 251)
  const file = await resources.createFile({ name: 'draft.bin', data: bytes })
  expect(file.size).toBe(bytes.length)
  const read = await resources.readBytes(file, { offset: 190 * 1024 })
  expect(read.data).toEqual(bytes.subarray(190 * 1024))
  const id = await request('resources.beginCreate', { name: 'partial.bin', size: 4 })
  await expect(f.service.viewRequest(other.id, other.generation, other.token, 'resources.commitSave', { id })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(f.hosts[0]!.broker('resources.commitSave', { id })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await request('resources.writeChunk', { id, offset: 0, base64: 'bmV3IQ==' })
  f.service.closeView(owner.id, owner.generation, owner.token)
  await expect(request('resources.commitSave', { id })).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await f.service.enable(value.id, false)
  expect(await f.store.resources.list(value.id, false)).toEqual([file])
  await expect(f.hosts[0]!.broker('resources.beginCreate', { name: 'late.bin', size: 0 })).rejects.toThrow('EXTENSION_HOST_STOPPED')
  expect(await readdir(join(f.root, 'extensions', 'data', value.id, 'files'))).toHaveLength(1)
})

it('keeps generated copies charged after releasing their source with all permissions disabled', async () => {
  const value = manifest({ apiVersion: 4, permissions: {}, contributes: { commands: [{ id: 'tests.reader.open', title: 'Open' }] } })
  const f = await fixture({}, value)
  await f.service.execute(value.id, 'tests.reader.open', null)
  const request = (method: string, params: JsonValue = null) => f.hosts[0]!.broker(method, params)
  const resources = createExtensionResourceClient(request)
  const original = await resources.createFile({ name: 'draft.txt', data: new Blob(['draft'], { type: 'text/plain;charset=utf-8' }) })
  const copy = await resources.importFile(original)
  await resources.release(original)
  expect(await resources.readText(copy)).toBe('draft')
  expect(copy.mimeType).toBe('text/plain')
  const path = join(f.root, 'extensions', 'data', value.id, 'owned-resources.json')
  const [owned] = JSON.parse(await readFile(path, 'utf8')) as Array<{ resource: ExtensionLocalFile, key: string, generated?: true }>
  await writeFile(path, JSON.stringify(Array.from({ length: EXTENSION_CREATED_FILES_LIMIT - 1 }, (_, index) => index ? { ...owned, resource: { ...copy, id: randomUUID() } } : owned)))
  const pending = await request('resources.beginCreate', { name: 'pending.txt', size: 0 })
  await expect(resources.importFile(copy)).rejects.toThrow('EXTENSION_RESOURCE_STORAGE_LIMIT')
  await request('resources.cancelSave', { id: pending })
  const results = await Promise.allSettled([resources.importFile(copy), resources.importFile(copy)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: new Error('EXTENSION_RESOURCE_STORAGE_LIMIT') })
  await expect(resources.createFile({ name: 'overflow.txt', data: new Uint8Array() })).rejects.toThrow('EXTENSION_RESOURCE_STORAGE_LIMIT')
  expect(await f.store.resources.list(value.id, false)).toHaveLength(EXTENSION_CREATED_FILES_LIMIT)
})

it('preserves an explicit MIME override through the SDK and validates direct host uploads', async () => {
  const value = manifest({ apiVersion: 4, permissions: {}, contributes: { commands: [{ id: 'tests.reader.open', title: 'Open' }] } })
  const f = await fixture({}, value)
  await f.service.execute(value.id, 'tests.reader.open', null)
  const request = (method: string, params: JsonValue = null) => f.hosts[0]!.broker(method, params)
  const resources = createExtensionResourceClient(request)
  const file = await resources.createFile({ name: 'draft', data: new Blob(['中文'], { type: 'text/plain' }), mimeType: 'Application/JSON; charset="utf-8"' })
  expect(file.mimeType).toBe('application/json')
  expect(await resources.readText(file)).toBe('中文')
  const response = await f.store.resources.response(value.id, file.id, new Request('https://resource.invalid'), new AbortController().signal, false)
  expect(response.headers.get('content-type')).toBe('application/json')
  expect(await response.text()).toBe('中文')
  const direct = await request('resources.beginCreate', { name: 'direct.txt', size: 0, mimeType: 'Text/Plain; charset=utf-8' })
  expect(await request('resources.commitSave', { id: direct })).toMatchObject({ mimeType: 'text/plain', size: 0 })
  await expect(request('resources.beginCreate', { name: 'bad.txt', size: 0, mimeType: 'text/plain; charset=utf-8\r\nInjected: value' })).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  expect(await resources.listFiles()).toHaveLength(2)
})

it('gates clipboard formats by independent permissions and live view ownership, including view-only plugins', async () => {
  const value = manifest({ apiVersion: 4, entry: undefined, permissions: { clipboardRead: true, clipboardWrite: true }, contributes: { views: [{ id: 'tests.reader.reader', title: 'Clipboard', entry: 'view.js', resource: 'none' }] } })
  let data = { text: '中文', html: '<table data-copy-id="one"><tr><td>中文</td></tr></table>' }
  let beforeIo: (() => void) | undefined
  const { service } = await fixture({ clipboard: { read: async (_session, check) => {
    beforeIo?.()
    check()
    return data
  }, write: async (_session, next, check) => {
    beforeIo?.()
    check()
    data = next as typeof data
  } } }, value)
  const session = await service.openView({ viewId: randomUUID(), extensionId: value.id, viewType: 'tests.reader.reader', resource: null, state: {}, stateVersion: 1 })
  const request = (method: string, input: unknown = null) => service.viewRequest(session.id, session.generation, session.token, method, input)
  expect(await request('clipboard.read')).toEqual(data)
  const large = '文'.repeat(100000)
  await request('clipboard.write', { text: large, html: '<b>format</b>' })
  expect(await request('clipboard.read')).toEqual({ text: large, html: '<b>format</b>' })
  await expect(request('clipboard.write', {})).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  await expect(request('clipboard.write', { text: '文'.repeat(1500000) })).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  await expect(request('clipboard.write', { text: 'ok', image: 'no' })).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  beforeIo = () => service.closeView(session.id, session.generation, session.token)
  await expect(request('clipboard.write', { text: 'stale' })).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  expect(data.text).toBe(large)
})
it.each(['clipboardRead', 'clipboardWrite'] as const)('does not infer %s from the opposite clipboard permission or expose it to a background host', async (permission) => {
  const value = manifest({ apiVersion: 4, permissions: { [permission === 'clipboardRead' ? 'clipboardWrite' : 'clipboardRead']: true }, contributes: { commands: [{ id: 'tests.reader.open', title: 'Open' }], views: [{ id: 'tests.reader.reader', title: 'Clipboard', entry: 'view.js', resource: 'none' }] } })
  const { service, hosts } = await fixture({}, value)
  const session = await service.openView({ viewId: randomUUID(), extensionId: value.id, viewType: 'tests.reader.reader', resource: null, state: {}, stateVersion: 1 })
  const method = permission === 'clipboardRead' ? 'clipboard.read' : 'clipboard.write'
  const input = permission === 'clipboardRead' ? null : { text: 'private' }
  await expect(service.viewRequest(session.id, session.generation, session.token, method, input)).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(hosts[0]!.broker(method, input)).rejects.toThrow('EXTENSION_METHOD_DENIED')
})
it('does not deliver a pending clipboard read after the view is closed', async () => {
  const pending = deferred<{ text: string }>()
  const value = manifest({ apiVersion: 4, permissions: { clipboardRead: true }, contributes: { views: [{ id: 'tests.reader.reader', title: 'Clipboard', entry: 'view.js', resource: 'none' }] } })
  const { service } = await fixture({ clipboard: { read: () => pending.promise, write: async () => {} } }, value)
  const session = await service.openView({ viewId: randomUUID(), extensionId: value.id, viewType: 'tests.reader.reader', resource: null, state: {}, stateVersion: 1 })
  const reading = service.viewRequest(session.id, session.generation, session.token, 'clipboard.read', null)
  await Promise.resolve()
  service.closeView(session.id, session.generation, session.token)
  pending.resolve({ text: 'private' })
  await expect(reading).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
})
it('limits header action requests to declared settings views and acknowledges the current renderer session', async () => {
  let accept = true
  const events: unknown[] = []
  const value = manifest({ apiVersion: 3, contributes: { views: [{ id: 'tests.reader.reader', title: 'Settings', entry: 'view.js', resource: 'none', location: 'page' }, { id: 'tests.reader.other', title: 'Page', entry: 'view.js', resource: 'none', location: 'page' }], settings: { modules: [{ id: 'tests.reader.settings', title: 'Settings', view: 'tests.reader.reader' }] } } })
  const { service, hosts } = await fixture({ workbench: async (event) => {
    events.push(event)
    return accept && event.kind === 'settings-header-actions' ? event.viewId : null
  } }, value)
  const input = { viewId: randomUUID(), extensionId: value.id, viewType: 'tests.reader.reader', resource: null, state: {}, stateVersion: 1 }
  const session = await service.openView(input)
  const request = (actions: unknown, token = session.token) => service.viewRequest(session.id, session.generation, token, 'view.setSettingsHeaderActions', actions)
  await request([{ id: 'engines', title: '  Engines  ', icon: 'settings' }])
  expect(events).toContainEqual({ kind: 'settings-header-actions', requestId: expect.any(String), viewId: session.id, generation: session.generation, token: session.token, actions: [{ id: 'engines', title: 'Engines', icon: 'settings' }] })
  for (const progress of [0, null, 100]) {
    await request([{ id: 'downloads', title: 'Download history 3', progress }])
    expect(events.at(-1)).toMatchObject({ kind: 'settings-header-actions', viewId: session.id, generation: session.generation, token: session.token, actions: [{ id: 'downloads', title: 'Download history 3', progress }] })
  }
  await expect(request([{ id: 'downloads', title: 'Download history 3', progress: 101 }])).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  await expect(request([{ id: 'engines', title: 'Engines', icon: 'arbitrary' }])).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  await expect(request([], randomUUID())).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await expect(hosts[0]!.broker('view.setSettingsHeaderActions', [])).rejects.toThrow('EXTENSION_METHOD_DENIED')
  const other = await service.openView({ ...input, viewId: randomUUID(), viewType: 'tests.reader.other' })
  await expect(service.viewRequest(other.id, other.generation, other.token, 'view.setSettingsHeaderActions', [])).rejects.toThrow('EXTENSION_METHOD_DENIED')
  accept = false
  await expect(request([])).rejects.toThrow('EXTENSION_SETTINGS_HEADER_ACTIONS_UNAVAILABLE')
  service.closeView(session.id, session.generation, session.token)
  await expect(request([])).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
})

it('acknowledges document metadata only after persistence for the requesting view session', async () => {
  let accept = true
  const events: unknown[] = []
  const value = manifest({ apiVersion: 4, contributes: { views: [{ id: 'tests.reader.reader', title: 'Document', entry: 'view.js', resource: 'none' }] } })
  const { service } = await fixture({ workbench: async (event) => {
    events.push(event)
    return accept && event.kind === 'document-info' ? event.viewId : null
  } }, value)
  const session = await service.openView({ viewId: randomUUID(), extensionId: value.id, viewType: 'tests.reader.reader', resource: null, state: {}, stateVersion: 1 })
  const request = (info: unknown, token = session.token) => service.viewRequest(session.id, session.generation, token, 'view.setDocumentInfo', info)
  await request({ title: '  季度计划.docx  ', dirty: true })
  expect(events).toContainEqual({ kind: 'document-info', requestId: expect.any(String), viewId: session.id, generation: session.generation, token: session.token, info: { title: '季度计划.docx', dirty: true } })
  await expect(request({ title: '', dirty: true })).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  await expect(request({ title: 'other', dirty: false }, randomUUID())).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  accept = false
  await expect(request({ title: 'not acknowledged', dirty: false })).rejects.toThrow('EXTENSION_DOCUMENT_INFO_FAILED')
})
it('denies clipboard and document metadata to decoration views despite declared clipboard permissions', async () => {
  const value = manifest({ apiVersion: 4, permissions: { clipboardRead: true, clipboardWrite: true, windowEffects: true }, contributes: { views: [{ id: 'tests.reader.reader', title: 'Decoration', entry: 'view.js', resource: 'none', location: 'window-overlay' }] } })
  const { service } = await fixture({}, value)
  const session = await service.openView({ viewId: randomUUID(), extensionId: value.id, viewType: 'tests.reader.reader', resource: null, state: {}, stateVersion: 1 })
  for (const [method, data] of [['clipboard.read', null], ['clipboard.write', { text: 'denied' }], ['view.setDocumentInfo', { title: 'denied', dirty: false }]] as const)
    await expect(service.viewRequest(session.id, session.generation, session.token, method, data)).rejects.toThrow('EXTENSION_METHOD_DENIED')
})

it.each([false, true])('waits for capability revocation before removing packages and data with clearData=%s', async (clearData) => {
  const entered = deferred<void>()
  const acknowledged = deferred<void>()
  const { service, store } = await fixture({ syncCapabilities: async (snapshot) => {
    expect(snapshot.every(descriptor => !descriptor.enabled)).toBe(true)
    entered.resolve()
    await acknowledged.promise
  } }, manifest({ id: 'tests.managed', apiVersion: 4, entry: undefined, contributes: { mcpConnectors: [{ id: 'search', name: 'Search', transport: 'streamable-http', url: 'https://example.com/mcp', authentication: 'none' }] } }))
  const pkg = store.installed['tests.managed']!.current
  await store.saveData('tests.managed', { retained: true }, 1)
  let completed = false
  const operation = service.uninstall('tests.managed', clearData).then(() => {
    completed = true
  })
  await entered.promise
  expect(completed).toBe(false)
  expect(store.installed['tests.managed']).toBeDefined()
  expect(await store.asset(pkg, 'extension.json')).toBeInstanceOf(Uint8Array)
  expect(await store.data('tests.managed')).toEqual({ version: 1, value: { retained: true } })
  acknowledged.resolve()
  await operation
  expect(completed).toBe(true)
  expect(store.installed['tests.managed']).toBeUndefined()
  await expect(readFile(join(store.packageRoot(pkg), 'extension.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await store.data('tests.managed')).toEqual(clearData ? { version: 0, value: {} } : { version: 1, value: { retained: true } })
})

it.each(['disable', 'uninstall', 'clear'] as const)('stops hosts and cancels dependency work when capability sync fails during %s, retaining a retryable installation', async (operation) => {
  const readingStarted = deferred<void>()
  const signals: AbortSignal[] = []
  let waiting = false
  let failSync = false
  const value = manifest({ apiVersion: 4, contributes: { ...manifest().contributes, subagents: [{ id: 'helper', name: 'Helper', instructions: 'Help.', tools: [], fileAccess: 'read_only' }] } })
  const { service, store, root, hosts } = await fixture({
    readText: async (_target, signal) => {
      if (!waiting)
        return 'Selected'
      signals.push(signal)
      if (signals.length === 2)
        readingStarted.resolve()
      return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
    syncCapabilities: async () => {
      if (failSync)
        throw new Error('EXTENSION_CAPABILITY_FAILED')
    },
  }, value)
  await store.install((await reviewPackage(root, store, manifest({ id: 'tests.dependent', dependencies: { [value.id]: '^1.0.0' } }))).token)
  await store.saveData(value.id, { retained: true }, 1)
  await store.saveConfiguration(value.id, { enabled: false })
  const pkg = store.installed[value.id]!.current
  await service.execute(value.id, `${value.id}.open`, target)
  await service.execute('tests.dependent', 'tests.dependent.open', target)
  waiting = true
  const readings = Promise.allSettled(hosts.map(host => host.broker('resources.readText', { id: (host.commands[0] as { resource: { id: string } }).resource.id })))
  await readingStarted.promise
  failSync = true
  const change = () => operation === 'disable' ? service.enable(value.id, false) : service.uninstall(value.id, operation === 'clear')
  await expect(change()).rejects.toThrow('EXTENSION_CAPABILITY_FAILED')
  expect(hosts).toHaveLength(2)
  expect(hosts.every(host => host.disposed)).toBe(true)
  expect(signals.every(signal => signal.aborted)).toBe(true)
  expect(await readings).toEqual(signals.map(() => ({ status: 'rejected', reason: expect.objectContaining({ name: 'AbortError' }) })))
  for (const host of hosts)
    await expect(host.broker('storage.set', { value: 'late', version: 1 })).rejects.toThrow('EXTENSION_HOST_STOPPED')
  expect((await service.list()).find(item => item.manifest.id === value.id)).toMatchObject({ enabled: false, state: 'disabled', generation: null })
  expect(JSON.parse(await readFile(join(store.root, 'installed.json'), 'utf8')).installed[value.id].enabled).toBe(false)
  expect(await store.asset(pkg, 'extension.json')).toBeInstanceOf(Uint8Array)
  expect(await store.data(value.id)).toEqual({ version: 1, value: { retained: true } })
  expect(JSON.parse(await readFile(join(store.root, 'data', value.id, 'configuration.json'), 'utf8'))).toEqual({ enabled: false })
  failSync = false
  await change()
  expect(store.installed[value.id]?.enabled).toBe(operation === 'disable' ? false : undefined)
  expect(await store.data(value.id)).toEqual(operation === 'clear' ? { version: 0, value: {} } : { version: 1, value: { retained: true } })
})

it('revokes capabilities despite disposal failure and retries the failed host before deleting its package', async () => {
  let failStop = true
  let running = false
  let revoked = false
  const value = manifest({ apiVersion: 4, contributes: { ...manifest().contributes, subagents: [{ id: 'helper', name: 'Helper', instructions: 'Help.', tools: [], fileAccess: 'read_only' }] } })
  const { service, store } = await fixture({
    createHost: () => ({
      call: async (method) => {
        if (method === 'activate')
          running = true
        return null
      },
      dispose: async () => {
        if (failStop)
          throw new Error('EXTENSION_HOST_DISPOSE_FAILED')
        running = false
      },
      devtools: () => {},
    }),
    syncCapabilities: async (descriptors) => { revoked = descriptors.every(descriptor => !descriptor.enabled) },
  }, value)
  const pkg = store.installed[value.id]!.current
  await store.saveData(value.id, { retained: true }, 1)
  await service.execute(value.id, `${value.id}.open`, null)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.uninstall(value.id, true)).rejects.toThrow('EXTENSION_HOST_DISPOSE_FAILED')
      expect(running).toBe(true)
      expect(revoked).toBe(true)
      expect(store.installed[value.id]?.enabled).toBe(false)
      expect(await store.asset(pkg, 'extension.json')).toBeInstanceOf(Uint8Array)
      expect(await store.data(value.id)).toEqual({ version: 1, value: { retained: true } })
    }
    failStop = false
    await service.uninstall(value.id, true)
    expect(running).toBe(false)
    expect(store.installed[value.id]).toBeUndefined()
    await expect(readFile(join(store.packageRoot(pkg), 'extension.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.data(value.id)).toEqual({ version: 0, value: {} })
  }
  finally {
    failStop = false
  }
})

const connector: ExtensionMcpConnectorContribution = { id: 'legal-search', name: 'Legal search', transport: 'streamable-http', url: 'https://legal.example.com/mcp', authentication: 'bearer' }
const subagent: ExtensionSubagentContribution = { id: 'law-finder', name: 'Law finder', description: '', instructions: 'Search statutes first.', skills: [], requiredSkills: [], tools: [{ source: 'mcp', connector: 'legal-search', name: 'legal__search' }], fileAccess: 'inherit' }

it('publishes declared MCP connectors and sub-agents without activating hosts and follows package state', async () => {
  const value = manifest({ id: 'tests.legal', apiVersion: 4, entry: undefined, permissions: {}, contributes: { mcpConnectors: [connector], subagents: [subagent] } })
  const { service, hosts } = await fixture({}, value)
  const [descriptor] = await service.capabilityContributions()
  expect(descriptor).toMatchObject({ extensionId: 'tests.legal', extensionName: value.name, enabled: true, mcpConnectors: [{ id: 'legal-search', url: 'https://legal.example.com/mcp', authentication: 'bearer' }], subagents: [{ id: 'law-finder' }] })
  await service.enable('tests.legal', false)
  expect(await service.capabilityContributions()).toEqual([{ ...descriptor, enabled: false }])
  await service.enable('tests.legal', true)
  expect(await service.capabilityContributions()).toEqual([descriptor])
  await service.uninstall('tests.legal')
  expect(await service.capabilityContributions()).toEqual([])
  expect(hosts).toHaveLength(0)
})
