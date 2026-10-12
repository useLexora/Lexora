import type { BuddyExecutionDefinition } from '../../buddies/BuddyExecutionDefinition'
import type { AdmitChildExecutionInput } from '../executionRepository'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { createBuddyRepository } from '../buddyRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { createExecutionRepository, executionFence, hashChildAdmissionRequest } from '../executionRepository'
import { createRunRepository } from '../runRepository'
import { createThreadBindingRepository } from '../threadBindingRepository'

export const executionNow = '2026-10-12T00:00:00.000Z'

export function createExecutionStorageFixture(databasePath = ':memory:') {
  const database = openBuddyDatabase({ databasePath })
  const buddies = createBuddyRepository(database)
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  const executions = createExecutionRepository(database)
  const threads = createThreadBindingRepository(database)
  const npc = buddies.create({ name: 'Research', kind: 'npc' })
  const actor = buddies.create({ name: 'Reviewer' })
  for (const id of ['default', actor.id]) {
    const buddy = buddies.get(id)
    buddies.update({ buddyId: id, expectedRevision: buddy.revision, settings: buddySettingsSchema.parse({ ...buddy.settings, npcIds: [npc.id] }) })
  }
  conversations.create({ id: 'conversation', branchId: 'branch', createdAt: executionNow, title: 'Fixture', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })

  conversations.addMember({ id: 'conversation', buddyId: actor.id, updatedAt: executionNow })

  function snapshot(actorId: string): BuddyExecutionDefinition {
    const buddy = buddies.get(actorId)
    return { version: 1, id: buddy.id, revision: buddy.revision, kind: buddy.kind, settings: buddySettingsSchema.parse(buddy.settings), model: { providerId: 'fixture', modelId: 'fixture', reasoning: null, serviceTier: null }, modelSource: buddy.kind === 'npc' ? 'caller' : 'definition' }
  }
  runs.create({ id: 'root', buddyId: 'default', actorSnapshot: snapshot('default'), branchId: 'branch', conversationId: 'conversation', triggeringMessageId: 'goal', provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'running', piSessionFile: null, startedAt: executionNow, approvalPolicy: 'policy', executionProfile: 'workspace_write' })

  function child(id: string, target = npc.id, callerId = 'root'): AdmitChildExecutionInput {
    const caller = executions.find(callerId)!
    const input: AdmitChildExecutionInput = {
      callerId,
      expectedCallerGeneration: caller.run.generation,
      expectedRootGeneration: executions.find(caller.run.rootRunId)!.run.generation,
      authorization: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      requestKey: `request-${id}`,
      requestHash: '',
      resultMailboxId: `result-${id}`,
      run: { id, buddyId: target, actorSnapshot: snapshot(target), conversationId: 'conversation', branchId: 'branch', triggeringMessageId: `private-${id}`, provider: 'fixture', model: 'fixture', purpose: 'chat', startedAt: executionNow, approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      initialInput: { prompt: 'Delegated goal', attachmentIds: [], contextItems: [], reasoning: null, serviceTier: null },
    }
    input.requestHash = hashChildAdmissionRequest(input)
    return input
  }
  function fence(runId: string) {
    const record = executions.find(runId)!
    return executionFence(record, executions.find(record.run.rootRunId)!)
  }
  return { database, buddies, conversations, runs, executions, threads, snapshot, npc, actor, child, fence }
}
