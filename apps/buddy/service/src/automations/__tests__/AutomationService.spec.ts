import type { DatabaseSync } from 'node:sqlite'
import type { AutomationCommit } from '../AutomationEvents'
import type { AutomationClock } from '../AutomationScheduleEvaluator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { createAutomationRepositories } from '../../storage/automationRepository'
import { createAutomationTurnRepository } from '../../storage/automationTurnRepository'
import { openBuddyDatabase } from '../../storage/database'
import { AutomationService, AutomationServiceError } from '../AutomationService'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true })
})

describe('automationService persistence', () => {
  it('publishes one immutable transaction batch after durable state and never republishes a replay', () => {
    const { service } = createFileService()
    const commits: AutomationCommit[] = []
    const observed: Array<{ kind: string, status: string | undefined }> = []
    service.onDidCommit(() => {
      throw new Error('optional observer failed')
    })
    service.onDidCommit((event) => {
      commits.push(event)
      for (const fact of event.facts) {
        if (fact.kind === 'definition.paused')
          observed.push({ kind: fact.kind, status: service.get(fact.automationId)?.status })
        if (fact.kind === 'occurrence.finished')
          observed.push({ kind: fact.kind, status: service.getOccurrence(fact.occurrenceId)?.status })
      }
    })
    const create = { requestId: 'create-facts', draft: dailyDraft('Facts') }
    const automation = service.create(create)
    service.create(create)
    const request = { automationId: automation.id, expectedRevision: 1, requestId: 'run-facts' }
    const queued = service.runNow(request)
    service.runNow(request)
    const pause = { automationId: automation.id, expectedRevision: 1, requestId: 'pause-facts' }
    service.pause(pause)
    service.pause(pause)
    expect(commits.map(event => event.facts.map(fact => fact.kind))).toEqual([
      ['definition.created'],
      ['occurrence.queued'],
      ['definition.paused', 'occurrence.finished'],
    ])
    expect(observed).toEqual([{ kind: 'definition.paused', status: 'paused' }, { kind: 'occurrence.finished', status: 'cancelled' }])
    expect(commits[2]!.facts[1]).toMatchObject({ occurrenceId: queued.occurrence.id, status: 'cancelled' })
    expect(Object.isFrozen(commits[2]!.facts[1])).toBe(true)
    expect(new Set(commits.map(event => event.operationId)).size).toBe(3)
    expect(commits.map(event => event.revision)).toEqual([1, 2, 3])
  })

  it('emits no definition or cancellation facts when their shared transaction rolls back', () => {
    const { service } = createFileService()
    const database = databases.at(-1)!
    const automation = service.create({ requestId: 'create-rollback', draft: dailyDraft('Rollback') })
    const queued = service.runNow({ automationId: automation.id, expectedRevision: 1, requestId: 'run-rollback' })
    const commits: AutomationCommit[] = []
    service.onDidCommit(event => commits.push(event))
    database.exec(`CREATE TRIGGER reject_cancel BEFORE UPDATE OF status ON automation_occurrences
      WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'cancel failed'); END`)
    expect(() => service.pause({ automationId: automation.id, expectedRevision: 1, requestId: 'pause-rollback' })).toThrow('cancel failed')
    expect(service.get(automation.id)).toMatchObject({ revision: 1, status: 'active' })
    expect(service.getOccurrence(queued.occurrence.id)?.status).toBe('queued')
    expect(commits).toEqual([])
  })

  it('returns the active occurrence when manual run is requested again', () => {
    const { service } = createFileService()
    const automation = service.create({ requestId: 'create-1', draft: dailyDraft('Active') })

    const started = service.runNow({
      automationId: automation.id,
      expectedRevision: automation.revision,
      requestId: 'run-now-1',
    })
    const repeated = service.runNow({
      automationId: automation.id,
      expectedRevision: automation.revision,
      requestId: 'run-now-2',
    })

    expect(started).toMatchObject({
      outcome: 'started',
      occurrence: {
        automationId: automation.id,
        status: 'queued',
        triggerKind: 'manual',
      },
    })
    expect(repeated).toMatchObject({
      outcome: 'already_running',
      occurrence: { id: started.occurrence.id },
    })
    expect(service.listHistory({ automationId: automation.id, limit: 20 }).items)
      .toHaveLength(1)
  })

  it('persists idempotent mutations, optimistic revisions and queued cancellation', () => {
    const { databasePath, service } = createFileService()
    const created = service.create({ requestId: 'create-1', draft: dailyDraft('Original') })

    expect(created).toMatchObject({
      name: 'Original',
      nextRunAt: '2026-08-24T01:30:00.000Z',
      revision: 1,
      status: 'active',
    })
    expect(service.create({ requestId: 'create-1', draft: dailyDraft('Original') }))
      .toEqual(created)
    expectAutomationError(
      () => service.create({ requestId: 'create-1', draft: dailyDraft('Changed') }),
      'AUTOMATION_CONFLICT',
    )

    const updated = service.update({
      automationId: created.id,
      draft: dailyDraft('Updated'),
      expectedRevision: 1,
      requestId: 'update-1',
    })
    expect(updated).toMatchObject({ name: 'Updated', revision: 2 })
    expect(service.update({
      automationId: created.id,
      draft: dailyDraft('Updated'),
      expectedRevision: 1,
      requestId: 'update-1',
    })).toEqual(updated)
    expectAutomationError(
      () => service.pause({
        automationId: created.id,
        expectedRevision: 1,
        requestId: 'pause-stale',
      }),
      'AUTOMATION_CONFLICT',
    )

    const manual = service.runNow({
      automationId: created.id,
      expectedRevision: 2,
      requestId: 'run-now-1',
    })
    expect(service.runNow({
      automationId: created.id,
      expectedRevision: 2,
      requestId: 'run-now-1',
    })).toEqual(manual)

    const paused = service.pause({
      automationId: created.id,
      expectedRevision: 2,
      requestId: 'pause-1',
    })
    expect(paused).toMatchObject({ nextRunAt: null, revision: 3, status: 'paused' })
    expect(service.listHistory({ automationId: created.id, limit: 20 }).items)
      .toEqual([expect.objectContaining({ id: manual.occurrence.id, status: 'cancelled' })])

    const resumed = service.resume({
      automationId: created.id,
      expectedRevision: 3,
      requestId: 'resume-1',
    })
    expect(resumed).toMatchObject({ revision: 4, status: 'active' })

    const page = service.list({ limit: 1 })
    expect(page.items).toEqual([resumed])
    expect(page.nextCursor).toBeNull()

    const deleted = service.delete({
      automationId: created.id,
      expectedRevision: 4,
      requestId: 'delete-1',
    })
    expect(deleted).toMatchObject({ revision: 5, status: 'completed' })
    expect(service.delete({
      automationId: created.id,
      expectedRevision: 4,
      requestId: 'delete-1',
    })).toEqual(deleted)
    expect(service.get(created.id)).toBeNull()

    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    const reopenedService = new AutomationService({
      clock: fixedClock('2026-08-24T00:00:00.000Z'),
      createId: incrementalIds('reopened'),
      repositories: createAutomationRepositories(reopened),
    })
    expect(reopenedService.get(created.id)).toBeNull()
    expect(reopenedService.listHistory({ automationId: created.id, limit: 20 }).items)
      .toHaveLength(1)
  })

  it('claims one scheduled occurrence atomically and preserves its execution snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-automation-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const first = openBuddyDatabase({ databasePath })
    const second = openBuddyDatabase({ databasePath })
    databases.push(first, second)
    const firstService = new AutomationService({
      clock: fixedClock('2026-08-24T00:00:00.000Z'),
      createId: incrementalIds('first'),
      repositories: createAutomationRepositories(first),
    })
    const secondService = new AutomationService({
      clock: fixedClock('2026-08-24T00:00:00.000Z'),
      createId: incrementalIds('second'),
      repositories: createAutomationRepositories(second),
    })
    const automation = firstService.create({ requestId: 'create-1', draft: dailyDraft('Original') })

    const firstClaim = firstService.claimScheduled({
      automationId: automation.id,
      coalescedMissedCount: 0,
      expectedRevision: automation.revision,
      scheduledFor: automation.nextRunAt!,
    })
    const secondClaim = secondService.claimScheduled({
      automationId: automation.id,
      coalescedMissedCount: 0,
      expectedRevision: automation.revision,
      scheduledFor: automation.nextRunAt!,
    })

    expect(firstClaim).toMatchObject({ triggerKind: 'scheduled', status: 'queued' })
    expect(secondClaim).toBeNull()
    expect(firstService.get(automation.id)?.nextRunAt).toBe('2026-08-25T01:30:00.000Z')

    firstService.update({
      automationId: automation.id,
      draft: dailyDraft('Changed after claim'),
      expectedRevision: automation.revision,
      requestId: 'update-1',
    })
    expect(firstService.getOccurrence(firstClaim!.id)?.executionSnapshot)
      .toMatchObject({ name: 'Original', prompt: 'Run Original' })
    expect(first.prepare(`
      SELECT COUNT(*) AS count FROM automation_occurrences
      WHERE automation_id = ? AND scheduled_for = ?
    `).get(automation.id, automation.nextRunAt)).toEqual({ count: 1 })
  })

  it('leases queued occurrences deterministically and reclaims only expired leases', () => {
    const { service } = createFileService()
    const first = service.create({ requestId: 'create-1', draft: dailyDraft('First') })
    const second = service.create({ requestId: 'create-2', draft: dailyDraft('Second') })
    const firstOccurrence = service.runNow({
      automationId: first.id,
      expectedRevision: first.revision,
      requestId: 'run-now-1',
    })
    const secondOccurrence = service.runNow({
      automationId: second.id,
      expectedRevision: second.revision,
      requestId: 'run-now-2',
    })

    expect(service.leaseQueued({
      leaseExpiresAt: '2026-08-24T00:01:00.000Z',
      limit: 1,
      now: '2026-08-24T00:00:00.000Z',
      owner: 'scheduler-1',
    }).map(item => item.id)).toEqual([firstOccurrence.occurrence.id])
    expect(service.leaseQueued({
      leaseExpiresAt: '2026-08-24T00:01:00.000Z',
      limit: 5,
      now: '2026-08-24T00:00:00.000Z',
      owner: 'scheduler-2',
    }).map(item => item.id)).toEqual([secondOccurrence.occurrence.id])
    expect(service.leaseQueued({
      leaseExpiresAt: '2026-08-24T00:03:00.000Z',
      limit: 5,
      now: '2026-08-24T00:02:00.000Z',
      owner: 'scheduler-3',
    }).map(item => item.id)).toEqual([
      firstOccurrence.occurrence.id,
      secondOccurrence.occurrence.id,
    ])
  })

  it('atomically skips a scheduled overlap and blocks invalid pinned dependencies', () => {
    const { databasePath, service } = createFileService()
    const database = databases.at(-1)!
    const automation = service.create({
      requestId: 'create-overlap',
      draft: {
        ...dailyDraft('Pinned'),
        model: {
          mode: 'pinned',
          modelId: 'model-1',
          providerId: 'provider-1',
          reasoning: null,
        },
      },
    })
    const manual = service.runNow({
      automationId: automation.id,
      expectedRevision: automation.revision,
      requestId: 'manual-overlap',
    })
    const leased = service.leaseQueued({
      leaseExpiresAt: '2026-08-24T00:01:00.000Z',
      limit: 1,
      now: '2026-08-24T00:00:00.000Z',
      owner: 'scheduler-overlap',
    })[0]!
    expect(leased.id).toBe(manual.occurrence.id)
    createAutomationTurnRepository(database).bind({
      boundAt: '2026-08-24T00:00:05.000Z',
      branchId: 'branch-overlap',
      contextWindow: 200_000,
      executionContext: null,
      conversationId: 'conversation-overlap',
      leaseOwner: 'scheduler-overlap',
      maxTokens: 32_000,
      messageId: 'message-overlap',
      model: 'model-1',
      occurrenceId: manual.occurrence.id,
      spaceId: null,
      provider: 'provider-1',
      reasoning: null,
      runId: 'run-overlap',
    })

    const overlappingManual = service.runNow({
      automationId: automation.id,
      expectedRevision: automation.revision,
      requestId: 'manual-overlap-2',
    })
    expect(overlappingManual).toMatchObject({
      occurrence: { id: manual.occurrence.id },
      outcome: 'already_running',
    })

    const scheduled = service.claimScheduled({
      automationId: automation.id,
      coalescedMissedCount: 0,
      expectedRevision: automation.revision,
      scheduledFor: automation.nextRunAt!,
    })

    expect(scheduled).toMatchObject({
      errorCode: 'OVERLAP_SKIPPED',
      status: 'skipped',
    })
    expect(service.blockPinnedModel('provider-1', 'model-1')).toEqual([
      expect.objectContaining({
        blockedReason: 'AUTOMATION_PINNED_MODEL_UNAVAILABLE',
        status: 'blocked',
      }),
    ])

    const reopened = openBuddyDatabase({ databasePath })
    databases.push(reopened)
    expect(new AutomationService({
      repositories: createAutomationRepositories(reopened),
    }).get(automation.id)).toMatchObject({
      blockedReason: 'AUTOMATION_PINNED_MODEL_UNAVAILABLE',
      status: 'blocked',
    })
  })

  it('rolls back occurrence settlement when persistent dependency blocking fails', () => {
    const { service } = createFileService()
    const database = databases.at(-1)!
    const automation = service.create({
      requestId: 'create-atomic-block',
      draft: dailyDraft('Atomic block'),
    })
    const occurrence = service.runNow({
      automationId: automation.id,
      expectedRevision: automation.revision,
      requestId: 'run-atomic-block',
    })
    service.leaseQueued({
      leaseExpiresAt: '2026-08-24T00:01:00.000Z',
      limit: 1,
      now: '2026-08-24T00:00:00.000Z',
      owner: 'scheduler-atomic-block',
    })
    database.exec(`
      CREATE TRIGGER reject_automation_block
      BEFORE UPDATE OF status ON automations
      WHEN NEW.status = 'blocked'
      BEGIN
        SELECT RAISE(ABORT, 'reject block');
      END;
    `)

    expect(() => service.finishQueuedAndBlock({
      automationId: automation.id,
      expectedRevision: automation.revision,
      id: occurrence.occurrence.id,
      leaseOwner: 'scheduler-atomic-block',
      reason: 'AUTOMATION_SPACE_UNAVAILABLE',
    })).toThrow(/reject block/)
    expect(service.getOccurrence(occurrence.occurrence.id)?.status).toBe('queued')
    expect(service.get(automation.id)?.status).toBe('active')
  })
})

function createFileService() {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-buddy-automation-'))
  directories.push(directory)
  const databasePath = join(directory, 'buddy.sqlite3')
  const database = openBuddyDatabase({ databasePath })
  databases.push(database)
  return {
    databasePath,
    service: new AutomationService({
      clock: fixedClock('2026-08-24T00:00:00.000Z'),
      createId: incrementalIds('id'),
      repositories: createAutomationRepositories(database),
    }),
  }
}

function dailyDraft(name: string) {
  return {
    executionProfile: 'workspace_write' as const,
    model: { mode: 'default' as const },
    name,
    spaceId: null,
    prompt: `Run ${name}`,
    timing: {
      activeFrom: null,
      activeUntil: null,
      schedule: {
        cadence: 'daily' as const,
        kind: 'calendar' as const,
        localTime: '09:30',
      },
      timezone: 'Asia/Shanghai',
    },
  }
}

function fixedClock(instant: string): AutomationClock {
  return { now: () => Temporal.Instant.from(instant) }
}

function incrementalIds(prefix: string): () => string {
  let next = 0
  return () => `${prefix}-${++next}`
}

function expectAutomationError(operation: () => unknown, code: string): void {
  try {
    operation()
    expect.fail('Expected automation operation to fail')
  }
  catch (error) {
    expect(error).toBeInstanceOf(AutomationServiceError)
    expect((error as AutomationServiceError).code).toBe(code)
  }
}
