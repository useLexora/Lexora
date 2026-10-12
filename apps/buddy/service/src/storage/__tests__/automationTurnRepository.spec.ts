import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { AutomationService } from '../../automations/AutomationService'
import { createAutomationRepositories } from '../automationRepository'
import {
  AutomationTurnBindingError,
  createAutomationTurnRepository,
} from '../automationTurnRepository'
import { openBuddyDatabase } from '../database'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('automationTurnRepository', () => {
  it('atomically binds a leased snapshot to the existing conversation and run facts', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const service = new AutomationService({
      clock: { now: () => Temporal.Instant.from('2026-08-24T00:00:00.000Z') },
      createId: incrementalIds('automation'),
      repositories: createAutomationRepositories(database),
    })
    const automation = service.create({
      requestId: 'create-1',
      draft: { ...dailyDraft(), executionProfile: 'full_access' },
    })
    const occurrence = service.runNow({
      automationId: automation.id,
      expectedRevision: automation.revision,
      requestId: 'run-now-1',
    })
    service.leaseQueued({
      leaseExpiresAt: '2026-08-24T00:01:00.000Z',
      limit: 1,
      now: '2026-08-24T00:00:00.000Z',
      owner: 'scheduler-1',
    })

    const bound = createAutomationTurnRepository(database).bind({
      boundAt: '2026-08-24T00:00:10.000Z',
      branchId: 'branch-1',
      contextWindow: 200_000,
      executionContext: null,
      conversationId: 'conversation-1',
      leaseOwner: 'scheduler-1',
      maxTokens: 32_000,
      messageId: 'message-1',
      model: 'model-1',
      occurrenceId: occurrence.occurrence.id,
      spaceId: null,
      provider: 'provider-1',
      reasoning: 'high',
      runId: 'run-1',
    })

    expect(bound.occurrence).toMatchObject({
      conversationId: 'conversation-1',
      runId: 'run-1',
      status: 'bound',
    })
    expect(database.prepare(`
      SELECT origin, deleted_at, execution_profile FROM conversations WHERE id = 'conversation-1'
    `).get()).toEqual({
      deleted_at: null,
      execution_profile: 'full_access',
      origin: 'automation',
    })
    expect(database.prepare(`
      SELECT purpose, status, execution_profile FROM runs WHERE id = 'run-1'
    `).get()).toEqual({
      execution_profile: 'full_access',
      purpose: 'automation',
      status: 'queued',
    })
    expect(database.prepare(`
      SELECT prompt, reasoning FROM run_inputs WHERE run_id = 'run-1'
    `).get()).toEqual({ prompt: 'Run daily', reasoning: 'high' })
    expect(database.prepare('SELECT actor_id, model_selection_json FROM conversation_members WHERE conversation_id = ?').get('conversation-1')).toEqual({ actor_id: 'default', model_selection_json: null })
  })

  it('rolls the whole binding back when the queued lease cannot be validated', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const service = new AutomationService({
      clock: { now: () => Temporal.Instant.from('2026-08-24T00:00:00.000Z') },
      createId: incrementalIds('automation'),
      repositories: createAutomationRepositories(database),
    })
    const automation = service.create({ requestId: 'create-1', draft: dailyDraft() })
    const occurrence = service.runNow({
      automationId: automation.id,
      expectedRevision: automation.revision,
      requestId: 'run-now-1',
    })

    const input = {
      boundAt: '2026-08-24T00:00:10.000Z',
      branchId: 'branch-1',
      contextWindow: null,
      executionContext: null,
      conversationId: 'conversation-1',
      leaseOwner: 'missing-owner',
      maxTokens: null,
      messageId: 'message-1',
      model: 'model-1',
      occurrenceId: occurrence.occurrence.id,
      spaceId: null,
      provider: 'provider-1',
      reasoning: null,
      runId: 'run-1',
    }
    const turns = createAutomationTurnRepository(database)

    expect(() => turns.bind(input)).toThrow(AutomationTurnBindingError)
    expect(() => turns.bind({
      ...input,
      occurrenceId: 'missing-occurrence',
    })).toThrow(AutomationTurnBindingError)
    expect(database.prepare('SELECT COUNT(*) AS count FROM conversations').get())
      .toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get())
      .toEqual({ count: 0 })
  })

  it('keeps one queued occurrence when the same automation is started twice', () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const service = new AutomationService({
      clock: { now: () => Temporal.Instant.from('2026-08-24T00:00:00.000Z') },
      createId: incrementalIds('automation'),
      repositories: createAutomationRepositories(database),
    })
    const automation = service.create({ requestId: 'create-1', draft: dailyDraft() })
    const first = service.runNow({
      automationId: automation.id,
      expectedRevision: automation.revision,
      requestId: 'run-now-1',
    })
    const second = service.runNow({
      automationId: automation.id,
      expectedRevision: automation.revision,
      requestId: 'run-now-2',
    })
    service.leaseQueued({
      leaseExpiresAt: '2026-08-24T00:01:00.000Z',
      limit: 2,
      now: '2026-08-24T00:00:00.000Z',
      owner: 'scheduler-1',
    })
    const turns = createAutomationTurnRepository(database)
    turns.bind(bindingInput(first.occurrence.id, '1'))

    expect(second).toMatchObject({
      occurrence: { id: first.occurrence.id },
      outcome: 'already_running',
    })
    expect(service.listHistory({ automationId: automation.id, limit: 20 }).items)
      .toHaveLength(1)
    expect(database.prepare('SELECT COUNT(*) AS count FROM conversations').get())
      .toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get())
      .toEqual({ count: 1 })

    function bindingInput(occurrenceId: string, suffix: string) {
      return {
        boundAt: '2026-08-24T00:00:10.000Z',
        branchId: `branch-${suffix}`,
        contextWindow: null,
        executionContext: null,
        conversationId: `conversation-${suffix}`,
        leaseOwner: 'scheduler-1',
        maxTokens: null,
        messageId: `message-${suffix}`,
        model: 'model-1',
        occurrenceId,
        spaceId: null,
        provider: 'provider-1',
        reasoning: null,
        runId: `run-${suffix}`,
      }
    }
  })
})

function dailyDraft() {
  return {
    executionProfile: 'workspace_write' as const,
    model: { mode: 'default' as const },
    name: 'Daily',
    spaceId: null,
    prompt: 'Run daily',
    timing: {
      activeFrom: null,
      activeUntil: null,
      schedule: { cadence: 'daily' as const, kind: 'calendar' as const, localTime: '09:30' },
      timezone: 'Asia/Shanghai',
    },
  }
}

function incrementalIds(prefix: string): () => string {
  let next = 0
  return () => `${prefix}-${++next}`
}
