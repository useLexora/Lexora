import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import { afterEach, describe, expect, it } from 'vitest'
import { buddiesRpc } from '../../../../shared/buddies/buddyApi'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { openBuddyDatabase } from '../../storage/database'
import { BuddiesService } from '../BuddiesService'
import { registerBuddiesRpc } from '../registerBuddiesRpc'
import { managedBuddyFixture } from './managedBuddyFixture'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()))
function fixture() {
  const database: DatabaseSync = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createBuddyRepository(database)
  const service = new BuddiesService(repository, { getModelType: () => null })
  cleanups.push(() => database.close(), () => service.dispose())
  const managed = managedBuddyFixture(database)
  const buddy = service.installManagedNpc(managed.input)
  return { ...managed, database, repository, service, buddy }
}

describe('managed NPC definitions', () => {
  it('accepts the dedicated duplicate RPC with revision protection and rejects injected identity', async () => {
    const f = fixture()
    const handlers = new Map<string, RuntimeRequestHandler>()
    cleanups.push(registerBuddiesRpc({ onRequest: (method, handler) => {
      handlers.set(method, handler)
      return () => {
        handlers.delete(method)
      }
    } }, f.service))
    const invoke = async (params: unknown) => handlers.get(buddiesRpc.duplicate.method)!(params)
    const request = { buddyId: f.buddy.id, expectedRevision: f.buddy.revision }
    const response = buddiesRpc.duplicate.response.parse(await invoke(request))
    expect(response).toMatchObject({ kind: 'npc', settings: f.buddy.settings })
    expect(response.id).not.toBe(f.buddy.id)
    expect(response).not.toHaveProperty('managed')
    await expect(invoke({ ...request, managed: f.buddy.managed })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(invoke({ ...request, expectedRevision: request.expectedRevision + 1 })).rejects.toMatchObject({ code: 'BUDDY_CONFLICT' })
  })

  it('requires a real subagent source and projects source metadata only for managed identities', async () => {
    const f = fixture()
    expect(() => f.service.installManagedNpc({ ...f.input, id: 'user-chosen-id' })).toThrow(expect.objectContaining({ code: 'BUDDY_INVALID_NPC_BINDING' }))
    const connector = f.sources.upsertSource({ extensionId: 'fixture-plugin', extensionName: 'Fixture plugin', contributionId: 'mcp', revision: 'r1', state: 'enabled', kind: 'mcp', definition: { id: 'mcp', name: 'MCP', transport: 'streamable-http', url: 'https://example.test/mcp', authentication: 'none' } })
    expect(() => f.service.installManagedNpc({ ...f.input, id: connector.id })).toThrow(expect.objectContaining({ code: 'BUDDY_INVALID_NPC_BINDING' }))
    expect(f.service.get('default')).not.toHaveProperty('managed')
    expect(f.service.list().buddies.find(buddy => buddy.id === f.buddy.id)).toMatchObject({ managed: { extensionId: 'fixture-plugin', revision: 'revision-1' } })
  })

  it('refreshes author fields while retaining the user model, preference and avatar', async () => {
    const f = fixture()
    const model = { providerId: 'user-provider', modelId: 'user-model', reasoning: null, serviceTier: null }
    const edited = await f.service.update({ buddyId: f.buddy.id, expectedRevision: f.buddy.revision, enabled: false, avatar: 'preset:npc-lilac', settings: { ...buddySettingsSchema.parse(f.buddy.settings), model } })
    const updated = f.service.installManagedNpc({ ...f.input, name: 'Updated name', description: 'Updated background', settings: { ...f.input.settings, instructions: 'Updated instructions', tools: { mode: 'none' }, skills: { mode: 'none' }, requiredSkills: [], limits: { fileAccess: 'inherit' } } })
    expect(updated).toMatchObject({ name: 'Updated name', description: 'Updated background', avatar: edited.avatar, enabled: false, managed: { userEnabled: false }, settings: { model, instructions: 'Updated instructions', tools: { mode: 'none' }, skills: { mode: 'none' }, requiredSkills: [], limits: { fileAccess: 'inherit' } } })
    expect(f.service.get(f.buddy.id).revision).toBeGreaterThan(edited.revision)
    f.sources.setState(f.buddy.id, 'disabled')
    f.service.refreshManaged(f.buddy.id)
    f.sources.setState(f.buddy.id, 'enabled')
    f.service.refreshManaged(f.buddy.id)
    expect(f.service.get(f.buddy.id)).toMatchObject({ enabled: false, managed: { userEnabled: false }, settings: { model } })
  })

  it('rejects all definition edits including full-settings and read-only escalation', async () => {
    const f = fixture()
    const settings = buddySettingsSchema.parse(f.buddy.settings)
    for (const patch of [
      { name: 'Changed' },
      { description: 'Changed' },
      { settings: { ...settings, instructions: 'Changed' } },
      { settings: { ...settings, tools: { mode: 'all' as const } } },
      { settings: { ...settings, skills: { mode: 'all' as const } } },
      { settings: { ...settings, requiredSkills: [] } },
      { settings: { ...settings, limits: { fileAccess: 'inherit' as const } } },
    ]) {
      await expect(f.service.update({ buddyId: f.buddy.id, expectedRevision: f.buddy.revision, ...patch })).rejects.toMatchObject({ code: 'BUDDY_MANAGED_PROTECTED' })
    }
    expect(() => f.repository.delete({ buddyId: f.buddy.id, expectedRevision: f.buddy.revision })).toThrow(expect.objectContaining({ code: 'BUDDY_MANAGED_PROTECTED' }))
    expect(f.service.get(f.buddy.id)).toEqual(f.buddy)
  })

  it.each(['disabled', 'removed', 'unavailable'] as const)('blocks %s sources without overwriting user preference and publishes a revision', (state) => {
    const f = fixture()
    const changes: unknown[] = []
    f.service.onDidChange(event => changes.push(event))
    f.sources.setState(f.buddy.id, state)
    f.service.refreshManaged(f.buddy.id)
    expect(f.service.get(f.buddy.id)).toMatchObject({ enabled: false, managed: { state, userEnabled: true }, revision: f.buddy.revision + 1 })
    expect(changes).toEqual([{ buddyId: f.buddy.id, catalogRevision: f.service.list().revision }])
    const current = f.service.get(f.buddy.id)
    const copy = f.service.duplicate({ buddyId: current.id, expectedRevision: current.revision })
    expect(copy).toMatchObject({ enabled: true, settings: current.settings })
    expect(copy).not.toHaveProperty('managed')
  })

  it('allows explicit bindings to present managed definitions whose dependencies are not configured yet', async () => {
    const f = fixture()
    f.sources.setUnavailableReason(f.buddy.id, 'dependency_unavailable')
    f.service.refreshManaged(f.buddy.id)
    expect(f.service.get(f.buddy.id).enabled).toBe(false)
    const current = f.service.get(f.buddy.id)
    const copy = f.service.duplicate({ buddyId: current.id, expectedRevision: current.revision })
    expect(copy.settings).toEqual(current.settings)
    expect(copy).not.toHaveProperty('managed')
    const actor = await f.service.create({ name: 'Coordinator' })
    const settings = { ...buddySettingsSchema.parse(actor.settings), npcIds: [f.buddy.id] }
    const bound = await f.service.update({ buddyId: actor.id, expectedRevision: actor.revision, settings })
    expect(bound.settings.npcIds).toEqual([f.buddy.id])
    f.sources.setState(f.buddy.id, 'removed')
    const other = await f.service.create({ name: 'Other' })
    await expect(f.service.update({ buddyId: other.id, expectedRevision: other.revision, settings })).rejects.toMatchObject({ code: 'BUDDY_INVALID_NPC_BINDING' })
    expect(await f.service.update({ buddyId: actor.id, expectedRevision: bound.revision, settings })).toEqual(bound)
  })

  it('creates independent editable user NPCs with references and preserves original settings and user model', async () => {
    const f = fixture()
    const model = { providerId: 'user-provider', modelId: 'user-model', reasoning: null, serviceTier: null }
    const original = await f.service.update({ buddyId: f.buddy.id, expectedRevision: f.buddy.revision, settings: { ...buddySettingsSchema.parse(f.buddy.settings), model } })
    expect(() => f.service.duplicate({ buddyId: original.id, expectedRevision: f.buddy.revision })).toThrow(expect.objectContaining({ code: 'BUDDY_CONFLICT' }))
    const copy = f.service.duplicate({ buddyId: original.id, expectedRevision: original.revision })
    expect(copy.id).not.toBe(original.id)
    expect(copy).not.toHaveProperty('managed')
    expect(copy.settings).toEqual(original.settings)
    expect(f.sources.get(copy.id)).toBeNull()
    const edited = await f.service.update({ buddyId: copy.id, expectedRevision: copy.revision, name: 'My researcher', settings: { ...buddySettingsSchema.parse(copy.settings), instructions: 'My instructions' } })
    f.service.installManagedNpc({ ...f.input, name: 'New upstream name' })
    f.sources.setState(original.id, 'removed')
    f.service.refreshManaged(original.id)
    expect(f.service.get(copy.id)).toEqual(edited)
    expect(f.service.get(copy.id).enabled).toBe(true)
    const deleted = f.service.delete({ buddyId: copy.id, expectedRevision: edited.revision })
    expect(() => f.service.duplicate({ buddyId: copy.id, expectedRevision: deleted.revision })).toThrow(expect.objectContaining({ code: 'BUDDY_DELETED' }))
  })

  it('clears only user configuration on explicit removal while retaining identity and definition', async () => {
    const f = fixture()
    await f.service.update({ buddyId: f.buddy.id, expectedRevision: f.buddy.revision, avatar: 'preset:npc-lilac', settings: { ...f.input.settings, model: { providerId: 'user', modelId: 'model', reasoning: null, serviceTier: null } } })
    f.service.clearManagedConfiguration(f.buddy.id)
    expect(f.service.get(f.buddy.id)).toMatchObject({ id: f.buddy.id, deletedAt: null, avatar: null, customAvatars: [], enabled: false, managed: { userEnabled: false }, settings: { ...f.input.settings, model: null } })
  })
})
