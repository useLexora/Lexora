import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { createAutomationRepositories } from '../../storage/automationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { AutomationService } from '../AutomationService'
import { AUTOMATION_TOOL_NAME } from '../automationToolContract'
import {
  classifyAutomationTool,
  createAutomationTool,
} from '../createAutomationTool'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('createAutomationTool', () => {
  it('classifies reads as first-party reads and mutations as always-confirm', () => {
    const service = createService()

    expect(classifyAutomationTool(service, AUTOMATION_TOOL_NAME, {
      operation: 'list',
    })).toEqual({ access: 'read' })

    expect(classifyAutomationTool(service, AUTOMATION_TOOL_NAME, {
      draft: dailyDraft('Daily review'),
      operation: 'upsert',
      requestId: 'create-daily-review',
    })).toMatchObject({
      forceAsk: true,
      approval: {
        automation: {
          executionProfile: 'workspace_write',
          modelMode: 'default',
          name: 'Daily review',
          operation: 'upsert',
          spaceId: null,
          timezone: 'Asia/Shanghai',
        },
      },
    })
  })

  it('uses the product service for idempotent upsert and queues run_now immediately', async () => {
    const service = createService()
    const facts: string[] = []
    service.onDidCommit(event => facts.push(...event.facts.map(fact => fact.kind)))
    const tool = createAutomationTool({ service })

    const created = await execute(tool, {
      draft: dailyDraft('Daily review'),
      operation: 'upsert',
      requestId: 'create-daily-review',
    })
    const replayed = await execute(tool, {
      draft: dailyDraft('Daily review'),
      operation: 'upsert',
      requestId: 'create-daily-review',
    })

    expect(created.details).toMatchObject({
      automation: {
        name: 'Daily review',
        revision: 1,
      },
      operation: 'upsert',
    })
    expect(replayed.details).toEqual(created.details)

    const automation = service.list().items[0]!
    const queued = await execute(tool, {
      automationId: automation.id,
      expectedRevision: automation.revision,
      operation: 'run_now',
      requestId: 'run-daily-review',
    })

    expect(queued.details).toMatchObject({
      occurrence: {
        automationId: automation.id,
        runId: null,
        status: 'queued',
      },
      operation: 'run_now',
      runNowOutcome: 'started',
    })
    expect(facts).toEqual(['definition.created', 'occurrence.queued'])

    const occurrenceId = service.listHistory({ automationId: automation.id }).items[0]!.id
    const changeCount = facts.length
    const repeated = await execute(tool, {
      automationId: automation.id,
      expectedRevision: automation.revision,
      operation: 'run_now',
      requestId: 'run-daily-review-again',
    })
    expect(repeated.details).toMatchObject({
      occurrence: { id: occurrenceId },
      runNowOutcome: 'already_running',
    })
    expect(facts).toHaveLength(changeCount)
  })
})

function createService(): AutomationService {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  return new AutomationService({
    clock: { now: () => Temporal.Instant.from('2026-08-24T00:00:00.000Z') },
    repositories: createAutomationRepositories(database),
  })
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

async function execute(
  tool: ReturnType<typeof createAutomationTool>,
  input: unknown,
): Promise<{ details: Record<string, unknown> }> {
  return await tool.execute(
    'tool-call-1',
    input as never,
    undefined,
    undefined,
    {} as never,
  ) as unknown as { details: Record<string, unknown> }
}
