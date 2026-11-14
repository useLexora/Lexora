import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { createAutomationRepositories } from '../../storage/automationRepository'
import { createAutomationTurnRepository } from '../../storage/automationTurnRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { AutomationOccurrenceLifecycleService } from '../AutomationOccurrenceLifecycleService'
import { AutomationService } from '../AutomationService'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('automationOccurrenceLifecycleService', () => {
  it('recovers a persisted deletion after notification cleanup fails without repeating the tombstone fact', async () => {
    const f = createBoundFixture()
    const commits: string[] = []
    f.automations.onDidCommit(event => commits.push(...event.facts.map(fact => fact.kind)))
    const failed = new AutomationOccurrenceLifecycleService({
      automations: f.automations,
      conversationLifecycle: {
        recover: async () => false,
        delete: async () => {
          throw new Error('must follow notification removal')
        },
      },
      notifications: {
        removeAutomationRun: () => {
          throw new Error('notification store unavailable')
        },
      },
    })
    const cleanup: string[] = []
    failed.onDidCleanup(event => cleanup.push(event.status))
    await expect(failed.deleteOccurrence(f.occurrence.id)).rejects.toThrow('notification store unavailable')
    expect(f.automations.listHistory({}).items).toEqual([])
    expect(f.automations.listPendingDeletions().map(item => item.id)).toEqual([f.occurrence.id])
    expect(commits).toEqual(['occurrence.deleted'])
    expect(cleanup).toEqual(['started', 'failed'])
    await expect(failed.recoverPendingDeletions()).resolves.toBeUndefined()
    expect(cleanup).toEqual(['started', 'failed', 'failed'])
    expect(f.automations.listPendingDeletions().map(item => item.id)).toEqual([f.occurrence.id])
    await failed.dispose()
    const recovered = new AutomationOccurrenceLifecycleService({ automations: f.automations, conversationLifecycle: { delete: async id => f.conversations.markDeleted(id, '2026-08-24T00:00:30.000Z'), recover: async id => f.conversations.markDeleted(id, '2026-08-24T00:00:30.000Z') }, notifications: { removeAutomationRun: () => true } })
    await recovered.recoverPendingDeletions()
    expect(f.automations.listPendingDeletions()).toEqual([])
    expect(f.conversations.isDeleted('conversation-recovery')).toBe(true)
    expect(commits).toEqual(['occurrence.deleted'])
    await expect(recovered.deleteOccurrence(f.occurrence.id)).resolves.toMatchObject({ deleted: false })
    await recovered.dispose()
  })

  it('shares deletion cleanup between history and conversation entry points and drains accepted work', async () => {
    const f = createBoundFixture()
    const gate = Promise.withResolvers<boolean>()
    const lifecycle = new AutomationOccurrenceLifecycleService({ automations: f.automations, conversationLifecycle: { delete: async () => gate.promise, recover: async () => false }, notifications: { removeAutomationRun: () => true } })
    const states: string[] = []
    lifecycle.onDidCleanup(event => states.push(event.status))
    const first = lifecycle.deleteOccurrence(f.occurrence.id)
    const second = lifecycle.deleteConversation('conversation-recovery')
    const stopping = lifecycle.dispose()
    expect(states).toEqual(['started'])
    gate.resolve(true)
    await stopping
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ deleted: true }, { deleted: true }])
    expect(states).toEqual(['started', 'completed'])
    await expect(lifecycle.deleteOccurrence(f.occurrence.id)).rejects.toThrow('stopped')
  })
})

function createBoundFixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const automations = new AutomationService({ clock: { now: () => Temporal.Instant.from('2026-08-24T00:00:00.000Z') }, repositories: createAutomationRepositories(database) })
  const definition = automations.create({ requestId: 'create-recovery', draft: { executionProfile: 'workspace_write', model: { mode: 'default' }, name: 'Recovery', prompt: 'Run recovery fixture', spaceId: null, timing: { activeFrom: null, activeUntil: null, schedule: { cadence: 'daily', kind: 'calendar', localTime: '12:00' }, timezone: 'Asia/Shanghai' } } })
  automations.runNow({ automationId: definition.id, expectedRevision: 1, requestId: 'run-recovery' })
  const occurrence = automations.leaseQueued({ now: '2026-08-24T00:00:00.000Z', leaseExpiresAt: '2026-08-24T00:01:00.000Z', limit: 1, owner: 'scheduler-recovery' })[0]!
  createAutomationTurnRepository(database).bind({ boundAt: '2026-08-24T00:00:10.000Z', branchId: 'branch-recovery', conversationId: 'conversation-recovery', contextWindow: 100_000, maxTokens: 8_000, executionContext: null, leaseOwner: 'scheduler-recovery', messageId: 'message-recovery', model: 'model', occurrenceId: occurrence.id, provider: 'provider', reasoning: null, runId: 'run-recovery', spaceId: null })
  createRunRepository(database).reconcileTerminal('run-recovery', 'completed', '2026-08-24T00:00:20.000Z', null)
  return { automations, occurrence, conversations: createConversationRepository(database) }
}
