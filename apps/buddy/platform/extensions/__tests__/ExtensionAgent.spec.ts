import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionServicePorts } from '../ExtensionService'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { extensionAgentInvocationSchema } from '../../../shared/extensions/extensionAgent'
import { addedExtensionPermissions, extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import { ExtensionService } from '../ExtensionService'
import { createStore, manifest, reviewPackage } from './fixtures'

const ports: ExtensionServicePorts = {
  createHost: () => ({ call: async () => null, dispose: async () => {}, devtools: () => {} }),
  createView: () => { throw new Error('unused') },
  changed: () => {},
  workbench: async () => null,
  get: async () => new Response(''),
  readText: async () => '',
}
function configuredManifest(id = 'tests.reader', agent = true) {
  return manifest({ id, apiVersion: 3, permissions: { agent, tasks: agent ? 'read' : 'none' }, contributes: {
    commands: [{ id: `${id}.open`, title: 'Open' }],
    ...(agent ? { agent: { enabledWhen: 'enabled', tools: [{ id: `${id}.tool`, title: 'Tool', description: 'Fixture', parameters: { type: 'object' as const, properties: {} } }] } } : {}),
    settings: {
      groups: [{ id: `${id}.group`, module: 'settings.runtime', title: 'Fixture' }],
      items: [
        { id: `${id}.enabled`, key: 'enabled', group: `${id}.group`, type: 'boolean', title: 'Enabled', default: true },
        { id: `${id}.mode`, key: 'mode', group: `${id}.group`, type: 'select', title: 'Mode', default: 'new', options: [{ label: 'New', value: 'new' }, { label: 'Old', value: 'old' }] },
        { id: `${id}.count`, key: 'count', group: `${id}.group`, type: 'number', title: 'Count', default: 1, min: 0, max: 100 },
      ],
    },
  } })
}

it('preserves incompatible upgrade values and repairs individual fields before restoring agent contributions', async () => {
  const { root, store } = await createStore()
  const original = configuredManifest()
  await store.install((await reviewPackage(root, store, original)).token)
  await store.saveConfiguration(original.id, { enabled: true, mode: 'old', count: 90, retired: 'preserve' })
  const upgraded = extensionManifestSchema.parse({ ...original, version: '1.1.0', contributes: { ...original.contributes, settings: { ...original.contributes.settings, items: original.contributes.settings.items.map(item => item.type === 'select' ? { ...item, options: [{ label: 'New', value: 'new' }] } : item.type === 'number' ? { ...item, max: 10 } : item) } } })
  await store.install((await reviewPackage(root, store, upgraded)).token)
  const service = new ExtensionService(store, ports)
  try {
    await service.restart(original.id)
    expect(await service.configurationSnapshot(original.id)).toEqual({ values: { enabled: true, mode: 'old', count: 90 }, invalidKeys: ['mode', 'count'] })
    await expect(service.configuration(original.id)).rejects.toThrow('EXTENSION_CONFIGURATION_INVALID')
    expect(await service.agentContributions()).toEqual([])
    await service.configure(original.id, { enabled: false })
    await service.configure(original.id, { mode: 'new' })
    expect(await service.configurationSnapshot(original.id)).toEqual({ values: { enabled: false, mode: 'new', count: 90 }, invalidKeys: ['count'] })
    await service.configure(original.id, { count: 1, enabled: true })
    expect((await service.agentContributions()).map(item => item.id)).toEqual([original.id])
    expect(await service.configuration(original.id)).toEqual({ enabled: true, mode: 'new', count: 1 })
    await store.uninstall(original.id)
    await store.install((await reviewPackage(root, store, original)).token)
    expect(await store.configuration(original.id)).toEqual({ enabled: true, mode: 'new', count: 1 })
    expect((await store.configurationSnapshot(original.id)).invalidKeys).toEqual([])
  }
  finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('publishes only effective agent catalog changes, leaving UI-only management and no-op writes alone', async () => {
  const { root, store } = await createStore()
  for (const definition of [configuredManifest(), configuredManifest('tests.ui', false)])
    await store.install((await reviewPackage(root, store, definition)).token)
  const snapshots: Promise<string[]>[] = []
  const service: ExtensionService = new ExtensionService(store, { ...ports, agentChanged: () => {
    snapshots.push(service.agentContributions().then(items => items.map(item => item.configurationRevision)))
  } })
  try {
    const original = await service.agentContributions()
    await service.configure('tests.ui', { count: 2 })
    await service.restart('tests.ui')
    await service.enable('tests.ui', false)
    await service.enable('tests.ui', true)
    await service.configure('tests.reader', { count: 1 })
    expect(await service.agentContributions()).toEqual(original)
    expect(snapshots).toEqual([])
    await service.configure('tests.reader', { count: 2 })
    expect(await Promise.all(snapshots)).toEqual([(await service.agentContributions()).map(item => item.configurationRevision)])
    expect(await snapshots[0]).not.toEqual(original.map(item => item.configurationRevision))
    await service.configure('tests.reader', { enabled: false })
    expect(await snapshots.at(-1)).toEqual([])
  }
  finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['hot', 'legacy', 'failed'] as const)('commits configuration with %s update handling while revoking old invocations', async (mode) => {
  const { root, store } = await createStore()
  const definition = configuredManifest()
  await store.install((await reviewPackage(root, store, definition)).token)
  let requestSignal: AbortSignal | undefined
  let applied: JsonValue = null
  let holding = true
  const service = new ExtensionService(store, { ...ports, createHost: (_pkg, broker) => ({
    call: async (method, params) => {
      if (method === 'agent.invoke')
        return broker('agent.request', { invocationId: (params as Record<string, JsonValue>).invocationId, method: 'task.get', params: null })
      if (method === 'configuration.changed') {
        if (mode === 'failed')
          throw new Error('EXTENSION_CONFIGURATION_UPDATE_FAILED')
        applied = params
        const change = params as Record<string, JsonValue>
        return { operationId: change.operationId!, generation: change.generation!, configurationRevision: change.configurationRevision!, applied: mode === 'hot' }
      }
      return null
    },
    dispose: async () => {},
    devtools: () => {},
  }), agentRequest: async (_input, signal) => {
    requestSignal = signal
    if (holding)
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    return { title: 'fixture' }
  } })
  const invoke = async () => {
    const descriptor = (await service.agentContributions())[0]!
    return service.invokeAgent(extensionAgentInvocationSchema.parse({ extensionId: descriptor.id, revision: descriptor.revision, configurationRevision: descriptor.configurationRevision, invocationId: randomUUID(), tool: 'tests.reader.tool', input: {} }), new AbortController().signal)
  }
  try {
    const before = invoke().then(() => 'completed', () => 'cancelled')
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    const generation = (await service.list())[0]!.generation
    const save = vi.spyOn(store, 'saveConfiguration').mockRejectedValueOnce(new Error('write failed'))
    await expect(service.configure(definition.id, { count: 2 })).rejects.toThrow('write failed')
    expect(requestSignal!.aborted).toBe(false)
    expect((await service.list())[0]!.generation).toBe(generation)
    save.mockRestore()
    await service.configure(definition.id, { count: 2 })
    expect(await before).toBe('cancelled')
    expect(await service.configuration(definition.id)).toMatchObject({ count: 2 })
    expect((await service.list())[0]!.generation).toBe(mode === 'hot' ? generation : null)
    if (mode === 'hot')
      expect(applied).toMatchObject({ configuration: { enabled: true, mode: 'new', count: 2 }, changedKeys: ['count'], operationId: expect.any(String), generation, configurationRevision: expect.any(String) })
    holding = false
    expect(await invoke()).toEqual({ title: 'fixture' })
  }
  finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('requires explicit API 3 permissions and owned, valid settings contributions', () => {
  const definition = manifest({ apiVersion: 3, permissions: { agent: true, models: true, tasks: 'title' }, contributes: {
    agent: { enabledWhen: 'enabled', tools: [{ id: 'tests.reader.rename', title: 'Rename', description: 'Rename task', parameters: { type: 'object', properties: {} } }] },
    settings: { groups: [{ id: 'tests.reader.group', module: 'settings.general', title: 'Fixture' }], items: [{ id: 'tests.reader.enabled', key: 'enabled', group: 'tests.reader.group', type: 'boolean', title: 'Enabled', default: true }] },
  } })
  expect(addedExtensionPermissions(manifest().permissions, definition.permissions)).toEqual(expect.arrayContaining(['agent', 'models', 'tasks:title']))
  expect(extensionManifestSchema.safeParse({ ...definition, apiVersion: 2 }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...definition, permissions: { agent: false } }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...definition, contributes: { ...definition.contributes, agent: { ...definition.contributes.agent, enabledWhen: 'unknown' } } }).success).toBe(false)
  for (const item of [
    { ...definition.contributes.settings.items[0], id: 'another.plugin.enabled' },
    { ...definition.contributes.settings.items[0], group: 'another.plugin.group' },
    { ...definition.contributes.settings.items[0], default: 'true' },
  ]) {
    expect(extensionManifestSchema.safeParse({ ...definition, contributes: { ...definition.contributes, settings: { ...definition.contributes.settings, items: [item] } } }).success).toBe(false)
  }
})

it('preserves false, null and retired settings through upgrades and reinstall', async () => {
  const { root, store } = await createStore()
  const original = manifest({ apiVersion: 3, contributes: { settings: {
    groups: [{ id: 'tests.reader.group', module: 'settings.general', title: 'Fixture' }],
    items: [
      { id: 'tests.reader.enabled', key: 'enabled', group: 'tests.reader.group', type: 'boolean', title: 'Enabled', default: true },
      { id: 'tests.reader.model', key: 'model', group: 'tests.reader.group', type: 'model', title: 'Model', default: { providerId: 'fixture', modelId: 'default' } },
      { id: 'tests.reader.retired', key: 'retired', group: 'tests.reader.group', type: 'string', title: 'Retired', default: '' },
    ],
  } } })
  try {
    await store.install((await reviewPackage(root, store, original)).token)
    await store.saveConfiguration(original.id, { enabled: false, model: null, retired: 'preserve' })
    const upgraded = extensionManifestSchema.parse({ ...original, version: '1.1.0', contributes: { settings: { ...original.contributes.settings, items: original.contributes.settings.items.slice(0, 2) } } })
    await store.install((await reviewPackage(root, store, upgraded)).token)
    await store.promote(original.id)
    expect(await store.configuration(original.id)).toEqual({ enabled: false, model: null })
    await store.saveConfiguration(original.id, { enabled: true, model: null })
    await store.uninstall(original.id)
    await store.install((await reviewPackage(root, store, original)).token)
    expect(await store.configuration(original.id)).toEqual({ enabled: true, model: null, retired: 'preserve' })
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

it('scopes task/model requests to live invocations, validates configuration and rejects stale or revoked contributions', async () => {
  const { root, store } = await createStore()
  const definition = manifest({ apiVersion: 3, permissions: { agent: true, tasks: 'title' }, contributes: {
    agent: { enabledWhen: 'enabled', tools: [{ id: 'tests.reader.rename', title: 'Rename', description: 'Rename task', parameters: { type: 'object', properties: {} } }] },
    settings: { groups: [{ id: 'tests.reader.group', module: 'settings.general', title: 'Fixture' }], items: [{ id: 'tests.reader.enabled', key: 'enabled', group: 'tests.reader.group', type: 'boolean', title: 'Enabled', default: true }] },
  } })
  await store.install((await reviewPackage(root, store, definition)).token)
  let broker!: (method: string, params: unknown) => Promise<JsonValue>
  let invoke!: (input: Record<string, JsonValue>) => Promise<JsonValue>
  let capturedSignal: AbortSignal | undefined
  const service = new ExtensionService(store, {
    createHost: (_pkg, request) => {
      broker = request
      return { call: async (method, params) => method === 'agent.invoke' ? invoke(params as Record<string, JsonValue>) : null, dispose: async () => {}, devtools: () => {} }
    },
    createView: () => { throw new Error('unused') },
    changed: () => {},
    workbench: async () => null,
    get: async () => new Response(''),
    readText: async () => '',
    agentRequest: async (_input, signal) => {
      capturedSignal = signal
      return { title: 'Scoped task' }
    },
  })
  try {
    const [descriptor] = await service.agentContributions()
    const input = extensionAgentInvocationSchema.parse({ extensionId: descriptor!.id, revision: descriptor!.revision, configurationRevision: descriptor!.configurationRevision, invocationId: randomUUID(), tool: 'tests.reader.rename', input: {} })
    invoke = async (request) => {
      await expect(broker('agent.request', { invocationId: randomUUID(), method: 'task.get', params: null })).rejects.toThrow('EXTENSION_AGENT_UNAVAILABLE')
      await expect(broker('agent.request', { invocationId: request.invocationId, method: 'models.generateText', params: { prompt: 'private' } })).rejects.toThrow('EXTENSION_PERMISSION_DENIED')
      return broker('agent.request', { invocationId: request.invocationId, method: 'task.get', params: null })
    }
    expect(await service.invokeAgent(input, new AbortController().signal)).toEqual({ title: 'Scoped task' })
    await expect(broker('agent.request', { invocationId: input.invocationId, method: 'task.get', params: null })).rejects.toThrow('EXTENSION_AGENT_UNAVAILABLE')
    await expect(service.configure('tests.reader', { enabled: 'false' })).rejects.toThrow('EXTENSION_CONFIGURATION_INVALID')
    expect(await service.configuration('tests.reader')).toEqual({ enabled: true })
    await service.configure('tests.reader', { enabled: false })
    expect(capturedSignal?.aborted).toBe(true)
    expect(await service.agentContributions()).toEqual([])
    await expect(service.invokeAgent(input, new AbortController().signal)).rejects.toThrow('EXTENSION_AGENT_UNAVAILABLE')
    expect(await store.configuration('tests.reader')).toEqual({ enabled: false })
    await service.enable('tests.reader', false)
    await service.enable('tests.reader', true)
    expect(await service.agentContributions()).toEqual([])
  }
  finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['create', 'activate', 'crash'])('withdraws agent contributions and dependents after a host %s failure and restores them on restart', async (failure) => {
  const { root, store } = await createStore()
  for (const id of ['tests.reader', 'tests.dependent', 'tests.other']) {
    const definition = manifest({ id, apiVersion: 3, permissions: { agent: true }, dependencies: id === 'tests.dependent' ? { 'tests.reader': '^1' } : {}, contributes: {
      agent: { tools: [{ id: `${id}.tool`, title: 'Fixture', description: 'Fixture agent tool', parameters: { type: 'object', properties: {} } }] },
    } })
    await store.install((await reviewPackage(root, store, definition)).token)
  }
  let failing = true
  let crash = () => {}
  const disposed = new Set<string>()
  const snapshots: Promise<string[]>[] = []
  const service: ExtensionService = new ExtensionService(store, {
    createHost: (pkg, _broker, failed) => {
      if (pkg.manifest.id === 'tests.reader') {
        if (failing && failure === 'create')
          throw new Error('EXTENSION_HOST_UNAVAILABLE')
        crash = failed
      }
      return {
        call: async (method) => {
          if (pkg.manifest.id === 'tests.reader' && failing && failure === 'activate' && method === 'activate')
            throw new Error('EXTENSION_ACTIVATION_FAILED')
          return 'completed'
        },
        dispose: async () => { disposed.add(pkg.manifest.id) },
        devtools: () => {},
      }
    },
    createView: () => { throw new Error('unused') },
    changed: () => {},
    agentChanged: () => { snapshots.push(service.agentContributions().then(items => items.map(item => item.id))) },
    workbench: async () => null,
    get: async () => new Response(''),
    readText: async () => '',
  })
  try {
    const descriptors = await service.agentContributions()
    expect(descriptors.map(item => item.id)).toEqual(['tests.reader', 'tests.dependent', 'tests.other'])
    const descriptor = descriptors.find(item => item.id === 'tests.dependent')!
    const invocation = extensionAgentInvocationSchema.parse({ extensionId: descriptor.id, revision: descriptor.revision, configurationRevision: descriptor.configurationRevision, invocationId: randomUUID(), tool: 'tests.dependent.tool', input: {} })
    if (failure === 'crash') {
      expect(await service.invokeAgent(invocation, new AbortController().signal)).toBe('completed')
      expect(snapshots).toEqual([])
      crash()
      await vi.waitFor(() => expect([...disposed].sort()).toEqual(['tests.dependent', 'tests.reader']))
    }
    else {
      await expect(service.invokeAgent(invocation, new AbortController().signal)).rejects.toThrow('EXTENSION_')
    }
    await service.agentContributions()
    expect(await Promise.all(snapshots)).toEqual([['tests.other']])
    await expect(service.invokeAgent(invocation, new AbortController().signal)).rejects.toThrow('EXTENSION_AGENT_UNAVAILABLE')
    failing = false
    await service.restart('tests.reader')
    expect(await snapshots.at(-1)).toEqual(['tests.reader', 'tests.dependent', 'tests.other'])
    expect(await service.invokeAgent(invocation, new AbortController().signal)).toBe('completed')
  }
  finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
