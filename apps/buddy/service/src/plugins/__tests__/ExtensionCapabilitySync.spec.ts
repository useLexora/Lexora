import type { ExtensionCapabilityDescriptor } from '../../../../shared/extensions/extensionCapabilities'
import type { ExtensionMcpConnectorContribution } from '../../../../shared/extensions/extensionMcpConnectors'
import type { McpServerRecord } from '../../storage/connectorRepository'
import { afterEach, describe, expect, it } from 'vitest'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { extensionCapabilityDescriptorSchema } from '../../../../shared/extensions/extensionCapabilities'
import { isManagedCapabilityEnabled } from '../../../../shared/extensions/managedCapability'
import { BuddiesService } from '../../buddies/BuddiesService'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createManagedCapabilityRepository, toManagedCapabilitySource } from '../../storage/managedCapabilityRepository'
import { ExtensionCapabilitySync } from '../ExtensionCapabilitySync'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function descriptor(patch: Partial<ExtensionCapabilityDescriptor> = {}) {
  return extensionCapabilityDescriptorSchema.parse({
    extensionId: 'tests.legal',
    extensionName: 'Legal',
    revision: 'a',
    enabled: true,
    mcpConnectors: [{ id: 'search', name: 'Search', transport: 'streamable-http', url: 'https://example.com/mcp', authentication: 'bearer' }],
    subagents: [{ id: 'researcher', name: 'Researcher', instructions: 'Find original sources.', tools: [{ source: 'mcp', connector: 'search', name: 'search_statutes' }], skills: ['tests.legal.research'], requiredSkills: ['tests.legal.research'], fileAccess: 'inherit' }],
    skills: ['tests.legal.research'],
    ...patch,
  })
}

function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const sources = createManagedCapabilityRepository(database)
  const buddies = new BuddiesService(createBuddyRepository(database), { getModelType: () => null })
  const records = new Map<string, McpServerRecord>()
  const catalogs = new Map<string, string[]>()
  let descriptors = [descriptor()]
  let readError: Error | undefined
  let failInstall = false
  let failNpc = false
  const clearFailures = new Set<string>()
  const refreshFailures = new Set<string>()
  const sync = new ExtensionCapabilitySync({
    sources,
    buddies: {
      list: () => buddies.list(),
      get: id => buddies.get(id),
      installManagedNpc(input) {
        if (failNpc) {
          failNpc = false
          throw new Error('NPC_INSTALL_FAILED')
        }
        return buddies.installManagedNpc(input)
      },
      refreshManaged: id => buddies.refreshManaged(id),
      clearManagedConfiguration: id => buddies.clearManagedConfiguration(id),
    },
    descriptors: async () => {
      if (readError)
        throw readError
      return descriptors
    },
    connectors: {
      list: () => [...records.values()].map((record) => {
        const source = sources.get(record.id)
        return source ? { ...record, enabled: isManagedCapabilityEnabled(source), managed: toManagedCapabilitySource(source) } : record
      }),
      tools: id => (catalogs.get(id) ?? []).map(name => ({ name, title: name, description: '', readOnly: true })),
      async applyManaged(source) {
        if (failInstall) {
          failInstall = false
          throw new Error('MCP_INSTALL_FAILED')
        }
        const definition = source.definition as ExtensionMcpConnectorContribution
        const old = records.get(source.id)
        records.set(source.id, { id: source.id, name: definition.name, transport: 'streamable-http', url: definition.url, command: null, args: null, cwd: null, credentialRef: old?.credentialRef ?? null, toolNamespace: source.id.replaceAll('-', '_').slice(0, 32), toolExposure: old?.toolExposure ?? 'deferred', enabled: false, executionConfirmedAt: null, createdAt: old?.createdAt ?? 'now', updatedAt: 'now' })
      },
      async refreshManaged(id) {
        if (refreshFailures.has(id))
          throw new Error('MCP_RESET_FAILED')
      },
      async clearManagedConfiguration(id) {
        if (clearFailures.has(id))
          throw new Error('MCP_SECRET_DELETE_FAILED')
        sources.clearConfiguration(id)
        const record = records.get(id)
        if (record)
          records.set(id, { ...record, credentialRef: null })
      },
    },
  })
  cleanups.push(() => {
    buddies.dispose()
    database.close()
  })
  const source = (kind: 'mcp' | 'subagent', extensionId = 'tests.legal') => sources.list(extensionId).find(item => item.kind === kind)!
  return {
    database,
    sources,
    buddies,
    records,
    catalogs,
    clearFailures,
    refreshFailures,
    sync,
    source,
    failNextInstall: () => { failInstall = true },
    failNextNpcInstall: () => { failNpc = true },
    setDescriptors: (next: ExtensionCapabilityDescriptor[]) => { descriptors = next },
    failRead: () => { readError = new Error('offline') },
  }
}

describe('managed extension capabilities', () => {
  it('allocates independent identities and scopes tools and Skills without changing actor teams', async () => {
    const f = fixture()
    const actor = await f.buddies.create({ name: 'Selected actor', kind: 'actor' })
    const definition = descriptor()
    await f.sync.apply([definition])
    const connector = f.source('mcp')
    const npc = f.buddies.get(f.source('subagent').id)
    expect(connector.id).not.toBe('search')
    expect(connector.userEnabled).toBe(false)
    expect(npc.managed).toMatchObject({ extensionId: 'tests.legal', unavailableReason: 'dependency_unavailable' })
    expect(npc.settings.tools).toEqual({ mode: 'selected', ids: [JSON.stringify(['mcp', connector.id, 'search_statutes'])] })
    expect(npc.settings.skills).toMatchObject({ mode: 'selected' })
    expect(npc.settings.requiredSkills).toHaveLength(1)
    expect(f.buddies.get(actor.id)).toEqual(actor)
    expect(f.buddies.get('default').settings.npcIds).not.toContain(npc.id)
  })

  it('does not collide with another plugin or an existing user connector', async () => {
    const f = fixture()
    f.records.set('search', { id: 'search', name: 'User', transport: 'streamable-http', url: 'https://private.example.com/mcp', credentialRef: 'user-secret', command: null, args: null, cwd: null, toolNamespace: 'user', toolExposure: 'direct', enabled: true, executionConfirmedAt: null, createdAt: 'then', updatedAt: 'then' })
    await f.sync.apply([descriptor(), descriptor({ extensionId: 'tests.other' })])
    expect(f.source('mcp').id).not.toBe(f.source('mcp', 'tests.other').id)
    expect(f.records.get('search')).toMatchObject({ enabled: true, credentialRef: 'user-secret', url: 'https://private.example.com/mcp' })
    expect(f.sources.get('search')).toBeNull()
  })

  it('keeps user model, switch and unbinding across package updates and startup refreshes', async () => {
    const f = fixture()
    await f.sync.apply([descriptor()])
    let npc = f.buddies.get(f.source('subagent').id)
    const model = { providerId: 'provider', modelId: 'model', reasoning: null, serviceTier: null }
    await f.buddies.update({ buddyId: npc.id, expectedRevision: npc.revision, enabled: false, settings: buddySettingsSchema.parse({ ...npc.settings, model }) })
    const actor = f.buddies.get('default')
    await f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: buddySettingsSchema.parse({ ...actor.settings, npcIds: actor.settings.npcIds.filter(id => id !== npc.id) }) })
    const update = descriptor({ revision: 'b' })
    update.subagents[0]!.instructions = 'Updated original rules.'
    await f.sync.apply([update])
    npc = f.buddies.get(npc.id)
    expect(npc.settings.model).toMatchObject(model)
    expect(npc.managed?.userEnabled).toBe(false)
    expect(npc.settings.instructions).toBe('Updated original rules.')
    expect(f.buddies.get('default').settings.npcIds).not.toContain(npc.id)
    f.sources.suspendAll()
    await f.sync.apply([update])
    expect(f.buddies.get('default').settings.npcIds).not.toContain(npc.id)
  })

  it('does not reactivate a user-disabled connector when a plugin is enabled', async () => {
    const f = fixture()
    await f.sync.apply([descriptor({ enabled: false })])
    const npc = f.buddies.get(f.source('subagent').id)
    expect(npc.enabled).toBe(false)
    f.sources.setUserEnabled(f.source('mcp').id, true)
    f.catalogs.set(f.source('mcp').id, ['search_statutes'])
    await f.sync.apply([descriptor()])
    expect(f.buddies.get(npc.id).enabled).toBe(true)
    await f.sync.apply([descriptor({ enabled: false })])
    expect(f.source('mcp').userEnabled).toBe(true)
    expect(f.buddies.get(npc.id).enabled).toBe(false)
    f.sources.setUserEnabled(f.source('mcp').id, false)
    await f.sync.apply([descriptor()])
    expect(f.source('mcp').userEnabled).toBe(false)
    expect(f.buddies.get(npc.id).enabled).toBe(false)
  })

  it('retains configuration and identities on uninstall, with explicit cleanup and safe reinstall', async () => {
    const f = fixture()
    await f.sync.apply([descriptor()])
    const connector = f.source('mcp')
    const npc = f.buddies.get(f.source('subagent').id)
    f.records.set(connector.id, { ...f.records.get(connector.id)!, credentialRef: 'retained-secret' })
    f.sources.setUserEnabled(connector.id, true)
    await f.sync.apply([])
    expect(f.source('mcp')).toMatchObject({ id: connector.id, state: 'removed', userEnabled: false })
    expect(f.records.get(connector.id)?.credentialRef).toBe('retained-secret')
    expect(f.buddies.get(npc.id).deletedAt).toBeNull()
    expect(f.buddies.get(npc.id).enabled).toBe(false)
    await f.sync.apply([descriptor()])
    expect(f.source('mcp')).toMatchObject({ id: connector.id, userEnabled: false })
    await f.sync.apply([descriptor({ enabled: false })], 'tests.legal')
    expect(f.records.get(connector.id)?.credentialRef).toBeNull()
    expect(f.buddies.get(npc.id).managed?.userEnabled).toBe(false)
  })

  it('reports retained configuration and custom NPC dependencies without digest guesses', async () => {
    const f = fixture()
    await f.sync.apply([descriptor()])
    const sourceNpc = f.buddies.get(f.source('subagent').id)
    const copy = await f.buddies.duplicate({ buddyId: sourceNpc.id, expectedRevision: sourceNpc.revision })
    expect(await f.sync.impact('tests.legal')).toMatchObject({ retained: [{ kind: 'mcp', name: 'Search' }, { kind: 'subagent', name: 'Researcher' }], dependents: [{ id: copy.id }] })
    await f.sync.apply([])
    expect(f.buddies.get(copy.id).deletedAt).toBeNull()
  })

  it('suspends but never removes records when the authoritative source cannot be read', async () => {
    const f = fixture()
    await f.sync.apply([descriptor()])
    f.failRead()
    await f.sync.schedule()
    expect(f.sources.list().every(source => source.state === 'unavailable')).toBe(true)
    expect(f.records.size).toBe(1)
    expect(f.buddies.get(f.source('subagent').id).deletedAt).toBeNull()
  })

  it('reapplies the NPC definition after an interrupted update instead of treating source metadata as success', async () => {
    const f = fixture()
    await f.sync.apply([descriptor()])
    const id = f.source('subagent').id
    const update = descriptor({ revision: 'b' })
    update.subagents[0]!.tools = []
    update.subagents[0]!.fileAccess = 'read_only'
    update.subagents[0]!.instructions = 'Read only after update.'
    f.failNextNpcInstall()
    await expect(f.sync.apply([update])).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'NPC_INSTALL_FAILED' })] })
    expect(f.source('subagent')).toMatchObject({ revision: 'b', state: 'unavailable' })
    expect(f.buddies.get(id).settings.limits.fileAccess).toBe('inherit')
    await f.sync.apply([update])
    expect(f.buddies.get(id)).toMatchObject({ enabled: true, settings: { instructions: 'Read only after update.', limits: { fileAccess: 'read_only' }, tools: { mode: 'none' } } })
  })

  it.each(['install', 'reset'] as const)('isolates MCP %s failures from independent NPCs and connections and recovers on retry', async (failure) => {
    const f = fixture()
    const main = descriptor()
    main.subagents.push({ id: 'reader', name: 'Reader', description: '', instructions: 'Local only.', fileAccess: 'read_only', tools: [], skills: [], requiredSkills: [] })
    const healthy = descriptor({ extensionId: 'tests.healthy', mcpConnectors: [], skills: [], subagents: [main.subagents[1]!] })
    const connectionOnly = descriptor({ extensionId: 'tests.connection', subagents: [], skills: [] })
    await f.sync.apply([main, healthy, connectionOnly])
    const connector = f.source('mcp')
    const otherConnector = f.source('mcp', 'tests.connection')
    f.sources.setUserEnabled(connector.id, true)
    f.sources.setUserEnabled(otherConnector.id, true)
    f.catalogs.set(connector.id, ['search_statutes'])
    await f.sync.refreshAvailability()
    const dependent = f.sources.find('tests.legal', 'subagent', 'researcher')!
    const independent = f.sources.find('tests.legal', 'subagent', 'reader')!
    const healthyNpc = f.source('subagent', 'tests.healthy')
    expect(f.buddies.get(dependent.id).enabled).toBe(true)
    const actor = f.buddies.get('default')
    const update = { ...main, revision: 'b' }
    update.subagents[1]!.instructions = 'Updated local rules.'
    if (failure === 'install')
      f.failNextInstall()
    else
      f.refreshFailures.add(connector.id)
    await expect(f.sync.apply([update, healthy, connectionOnly])).rejects.toMatchObject({ code: 'EXTENSION_CAPABILITY_FAILED' })
    expect(f.sources.get(connector.id)?.state).toBe('unavailable')
    expect(f.buddies.get(dependent.id)).toMatchObject({ enabled: false, managed: { unavailableReason: 'dependency_unavailable' } })
    expect(f.buddies.get(independent.id)).toMatchObject({ enabled: true, settings: { instructions: 'Updated local rules.' } })
    expect(f.buddies.get(healthyNpc.id).enabled).toBe(true)
    expect(isManagedCapabilityEnabled(f.sources.get(otherConnector.id)!)).toBe(true)
    expect(f.buddies.get('default')).toEqual(actor)
    f.refreshFailures.clear()
    await f.sync.apply([update, healthy, connectionOnly])
    expect(f.buddies.get(dependent.id).enabled).toBe(true)
    expect(f.sources.get(connector.id)?.state).toBe('enabled')
    expect(f.buddies.get('default')).toEqual(actor)
  })

  it('keeps unrelated team membership and configuration when MCP cleanup fails, then retries without losing identity', async () => {
    const f = fixture()
    const healthy = descriptor({ extensionId: 'tests.healthy' })
    healthy.subagents[0]!.tools = []
    await f.sync.apply([descriptor(), healthy])
    const connector = f.source('mcp')
    f.records.set(connector.id, { ...f.records.get(connector.id)!, credentialRef: 'retained-secret' })
    const healthyNpc = f.buddies.get(f.source('subagent', 'tests.healthy').id)
    const current = f.buddies.get('default')
    const actor = await f.buddies.update({ buddyId: current.id, expectedRevision: current.revision, settings: buddySettingsSchema.parse({ ...current.settings, npcIds: [healthyNpc.id] }) })
    f.clearFailures.add(connector.id)
    await expect(f.sync.apply([descriptor({ enabled: false }), healthy], 'tests.legal')).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'MCP_SECRET_DELETE_FAILED' })] })
    expect(f.records.get(connector.id)?.credentialRef).toBe('retained-secret')
    expect(f.sources.get(connector.id)?.state).toBe('unavailable')
    expect(f.buddies.get(healthyNpc.id)).toEqual(healthyNpc)
    expect(f.buddies.get('default')).toEqual(actor)
    f.clearFailures.clear()
    await f.sync.apply([descriptor({ enabled: false }), healthy], 'tests.legal')
    expect(f.records.get(connector.id)?.credentialRef).toBeNull()
    expect(f.sources.get(connector.id)?.state).toBe('disabled')
    expect(f.buddies.get('default')).toEqual(actor)
  })

  it('revokes all effective states on authority loss even if one connection cannot finish closing', async () => {
    const f = fixture()
    const healthy = descriptor({ extensionId: 'tests.healthy' })
    healthy.subagents[0]!.tools = []
    await f.sync.apply([descriptor(), healthy])
    const connector = f.source('mcp')
    f.sources.setUserEnabled(connector.id, true)
    f.refreshFailures.add(connector.id)
    f.failRead()
    await f.sync.schedule()
    expect(f.sources.list().every(source => source.state === 'unavailable')).toBe(true)
    expect(f.buddies.get(f.source('subagent', 'tests.healthy').id).enabled).toBe(false)
    expect(f.sources.get(connector.id)?.userEnabled).toBe(true)
    expect(f.records.size).toBe(2)
  })

  it('leaves an accepted snapshot intact when a queued apply was cancelled before admission', async () => {
    const f = fixture()
    await f.sync.apply([descriptor()])
    const before = f.sources.list()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(f.sync.apply([], undefined, controller.signal)).rejects.toThrow('cancelled')
    expect(f.sources.list()).toEqual(before)
  })

  it('ignores an older discovery read after an explicit lifecycle snapshot', async () => {
    const f = fixture()
    const stale = f.sync.schedule()
    await f.sync.apply([descriptor({ enabled: false })])
    await stale
    expect(f.source('mcp').state).toBe('disabled')
  })
})
