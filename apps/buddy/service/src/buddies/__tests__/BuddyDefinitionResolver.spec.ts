import type { Api, Model } from '@earendil-works/pi-ai'
import type { DatabaseSync } from 'node:sqlite'
import type { BuddySettings } from '../../../../shared/buddies/buddySettings'
import type { InteractiveModelSelection, RuntimeModelProvider } from '../../providers/resolveInteractiveModelSelection'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it } from 'vitest'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { createConversationMemberRepository } from '../../storage/conversationMemberRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { BuddiesService } from '../BuddiesService'
import { BuddyDefinitionResolver } from '../BuddyDefinitionResolver'
import { buddyExecutionFingerprint } from '../BuddyExecutionDefinition'

const databases: DatabaseSync[] = []
const services: BuddiesService[] = []
const timestamp = '2026-10-11T10:00:00.000Z'

afterEach(() => {
  for (const service of services.splice(0))
    service.dispose()
  for (const database of databases.splice(0))
    database.close()
})

function modelSelection(modelId: string): InteractiveModelSelection {
  return { providerId: 'fixture', modelId, reasoning: null, serviceTier: null }
}

function setup(beforeResolve?: () => Promise<void>) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const repository = createBuddyRepository(database)
  const buddies = new BuddiesService(repository)
  services.push(buddies)
  const members = createConversationMemberRepository(database)
  const conversations = createConversationRepository(database)
  let defaultModel = modelSelection('application-default')
  const providers: RuntimeModelProvider = {
    getDefaultModel: async () => defaultModel,
    executionModels: {
      getServiceTiers: () => [{ id: 'priority', displayName: 'Priority' }],
      async resolveAvailable(input): Promise<Model<Api>> {
        await beforeResolve?.()
        return {
          api: 'openai-responses',
          baseUrl: 'https://models.example.test',
          contextWindow: 128000,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
          id: input.modelId,
          input: ['text'],
          maxTokens: 16384,
          name: input.modelId,
          provider: input.providerId,
          reasoning: true,
        }
      },
    },
  }
  const resolver = new BuddyDefinitionResolver({ buddies, members, providers })
  function createConversation(id: string) {
    return conversations.create({ id, branchId: `${id}-branch`, title: null, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: timestamp })
  }
  function setMemberModel(conversationId: string, actorId: string, selection: InteractiveModelSelection) {
    members.join({ conversationId, actorId, joinedAt: timestamp })
    members.setModelSelection({ conversationId, actorId, modelSelection: selection, updatedAt: timestamp })
  }
  async function updateSettings(buddyId: string, changes: Partial<BuddySettings>) {
    const current = buddies.get(buddyId)
    return buddies.update({ buddyId, expectedRevision: current.revision, settings: buddySettingsSchema.parse({ ...current.settings, ...changes }) })
  }
  return { buddies, conversations, createConversation, repository, resolver, setMemberModel, updateSettings, setDefaultModel: (value: InteractiveModelSelection) => defaultModel = value }
}

describe('buddy execution definitions', () => {
  it('allows a disabled team to retain unavailable NPC bindings without blocking the actor', async () => {
    const fixture = setup()
    const actor = fixture.buddies.get('default')
    const npcId = actor.settings.npcIds[0]!
    const npc = fixture.buddies.get(npcId)
    await fixture.buddies.update({ buddyId: npc.id, expectedRevision: npc.revision, enabled: false })
    await fixture.updateSettings(actor.id, { npcTeamEnabled: false })
    expect((await fixture.resolver.resolve({ buddyId: actor.id, kind: 'actor', conversationId: null })).definition.settings)
      .toEqual({ ...actor.settings, npcTeamEnabled: false })
    await expect(fixture.updateSettings(actor.id, { npcTeamEnabled: true })).rejects.toMatchObject({ code: 'BUDDY_INVALID_NPC_BINDING' })
  })

  it('resolves role defaults before the application default and applies an explicit request without changing either', async () => {
    const fixture = setup()
    const actor = await fixture.buddies.create({ name: 'Actor' })
    const actorModel = modelSelection('actor-default')
    const base = await fixture.resolver.resolve({ buddyId: actor.id, kind: 'actor', conversationId: null })
    expect(base.definition).toMatchObject({ id: actor.id, model: modelSelection('application-default'), modelSource: 'application' })
    await fixture.updateSettings(actor.id, { model: actorModel })
    fixture.setDefaultModel(modelSelection('new-application-default'))
    const configured = await fixture.resolver.resolve({ buddyId: actor.id, kind: 'actor', conversationId: null })
    expect(configured.definition).toMatchObject({ model: actorModel, modelSource: 'definition' })
    expect(configured.selection).toMatchObject({ ...actorModel, api: 'openai-responses', contextWindow: 128000, input: ['text'], maxTokens: 16384 })
    const requested = modelSelection('explicit-request')
    expect((await fixture.resolver.resolve({ buddyId: actor.id, kind: 'actor', conversationId: null, requestedModel: requested })).definition)
      .toMatchObject({ model: requested, modelSource: 'input' })
    expect((await fixture.resolver.resolve({ buddyId: actor.id, kind: 'actor', conversationId: null })).definition.model).toEqual(actorModel)
    expect(fixture.buddies.get(actor.id).settings.model).toEqual(actorModel)
  })

  it('isolates temporary model overrides by both conversation and actor across leader changes', async () => {
    const fixture = setup()
    const first = await fixture.buddies.create({ name: 'First' })
    const second = await fixture.buddies.create({ name: 'Second' })
    await fixture.updateSettings(first.id, { model: modelSelection('first-default') })
    await fixture.updateSettings(second.id, { model: modelSelection('second-default') })
    fixture.createConversation('task-one')
    fixture.createConversation('task-two')
    fixture.setMemberModel('task-one', first.id, modelSelection('first-task-one'))
    fixture.setMemberModel('task-one', second.id, modelSelection('second-task-one'))
    fixture.setMemberModel('task-two', first.id, modelSelection('first-task-two'))
    fixture.conversations.addMember({ id: 'task-one', buddyId: second.id, updatedAt: timestamp })
    fixture.conversations.setBuddy({ id: 'task-one', buddyId: second.id, updatedAt: timestamp })
    for (const [conversationId, actorId, expectedModel] of [
      ['task-one', first.id, 'first-task-one'],
      ['task-one', second.id, 'second-task-one'],
      ['task-two', first.id, 'first-task-two'],
    ]) {
      const result = await fixture.resolver.resolve({ buddyId: actorId!, kind: 'actor', conversationId: conversationId! })
      expect(result.definition).toMatchObject({ id: actorId, model: modelSelection(expectedModel!), modelSource: 'conversation' })
    }
    await expect(fixture.resolver.resolve({ buddyId: second.id, kind: 'actor', conversationId: 'task-two' })).rejects.toMatchObject({ code: 'BUDDY_NOT_MEMBER' })
    fixture.conversations.addMember({ id: 'task-two', buddyId: second.id, updatedAt: timestamp })
    const unrelated = await fixture.resolver.resolve({ buddyId: second.id, kind: 'actor', conversationId: 'task-two' })
    expect(unrelated.definition).toMatchObject({ model: modelSelection('second-default'), modelSource: 'definition' })
    fixture.conversations.addMember({ id: 'task-one', buddyId: first.id, updatedAt: timestamp })
    fixture.conversations.setBuddy({ id: 'task-one', buddyId: first.id, updatedAt: timestamp })
    expect((await fixture.resolver.resolve({ buddyId: first.id, kind: 'actor', conversationId: 'task-one' })).definition.model).toEqual(modelSelection('first-task-one'))
  })

  it('inherits the caller request model for an NPC independently of pending member and application choices', async () => {
    const fixture = setup()
    const first = await fixture.buddies.create({ name: 'First' })
    const second = await fixture.buddies.create({ name: 'Second' })
    const npc = await fixture.buddies.create({ name: 'Researcher', kind: 'npc' })
    fixture.createConversation('task')
    fixture.setMemberModel('task', first.id, modelSelection('pending-next-request'))
    fixture.setMemberModel('task', second.id, modelSelection('other-actor'))
    fixture.conversations.addMember({ id: 'task', buddyId: second.id, updatedAt: timestamp })
    fixture.conversations.setBuddy({ id: 'task', buddyId: second.id, updatedAt: timestamp })
    fixture.setDefaultModel(modelSelection('pending-application-choice'))
    const callerModel: InteractiveModelSelection = { ...modelSelection('active-request'), reasoning: 'high', serviceTier: 'priority' }
    const inherited = await fixture.resolver.resolve({ buddyId: npc.id, kind: 'npc', conversationId: 'task', callerModel })
    expect(inherited.definition).toMatchObject({ id: npc.id, kind: 'npc', model: callerModel, modelSource: 'caller' })
    expect(inherited.selection).toMatchObject(callerModel)
    await expect(fixture.resolver.resolve({ buddyId: npc.id, kind: 'npc', conversationId: 'task' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const configuredModel = modelSelection('research-model')
    await fixture.updateSettings(npc.id, { model: configuredModel })
    expect((await fixture.resolver.resolve({ buddyId: npc.id, kind: 'npc', conversationId: 'task', callerModel })).definition)
      .toMatchObject({ model: configuredModel, modelSource: 'definition' })
  })

  it('keeps accepted snapshots stable and excludes avatar-only changes from execution fingerprints', async () => {
    const fixture = setup()
    const actor = fixture.repository.create({ name: 'Actor', avatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aU1cAAAAASUVORK5CYII=' })
    const original = (await fixture.resolver.resolve({ buddyId: actor.id, kind: 'actor', conversationId: null })).definition
    const snapshot = structuredClone(original)
    await fixture.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, avatar: null })
    const changedAvatar = (await fixture.resolver.resolve({ buddyId: actor.id, kind: 'actor', conversationId: null })).definition
    expect(changedAvatar.revision).toBeGreaterThan(original.revision)
    expect(buddyExecutionFingerprint(changedAvatar)).toBe(buddyExecutionFingerprint(original))
    await fixture.updateSettings(actor.id, { instructions: 'New execution instructions', tools: { mode: 'none' }, model: modelSelection('new-role-model') })
    const changedDefinition = (await fixture.resolver.resolve({ buddyId: actor.id, kind: 'actor', conversationId: null })).definition
    expect(changedDefinition).toMatchObject({ settings: { instructions: 'New execution instructions', tools: { mode: 'none' } }, model: modelSelection('new-role-model') })
    expect(buddyExecutionFingerprint(changedDefinition)).not.toBe(buddyExecutionFingerprint(original))
    expect(original).toEqual(snapshot)
  })

  it.each(['instructions', 'actor-disabled', 'actor-deleted', 'npc-disabled', 'npc-deleted', 'member-model'] as const)('rejects %s changes while model availability is being validated', async (change) => {
    const started = deferred<void>()
    const release = deferred<void>()
    const fixture = setup(async () => {
      started.resolve()
      await release.promise
    })
    const actor = await fixture.buddies.create({ name: 'Actor' })
    const npc = await fixture.buddies.create({ name: 'Researcher', kind: 'npc' })
    await fixture.updateSettings(actor.id, { npcIds: [npc.id] })
    const conversation = fixture.createConversation('race')
    fixture.setMemberModel(conversation.id, actor.id, modelSelection('before-validation'))
    const pending = fixture.resolver.resolve({ buddyId: actor.id, kind: 'actor', conversationId: conversation.id })
    const assertion = expect(pending).rejects.toMatchObject({ code: change.startsWith('npc-') ? 'BUDDY_INVALID_NPC_BINDING' : 'BUDDY_CONFLICT' })
    await started.promise
    if (change === 'member-model') {
      fixture.setMemberModel(conversation.id, actor.id, modelSelection('after-validation'))
    }
    else if (change === 'instructions') {
      await fixture.updateSettings(actor.id, { instructions: 'Edited during resolution' })
    }
    else {
      const current = fixture.buddies.get(change.startsWith('npc-') ? npc.id : actor.id)
      if (change.endsWith('disabled'))
        await fixture.buddies.update({ buddyId: current.id, expectedRevision: current.revision, enabled: false })
      else
        fixture.buddies.delete({ buddyId: current.id, expectedRevision: current.revision })
    }
    release.resolve()
    await assertion
  })
})
