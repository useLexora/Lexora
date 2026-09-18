import type { DatabaseSync } from 'node:sqlite'
import type { AutomationModelTarget } from '../../../../shared/automation'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAutomationRepositories } from '../../storage/automationRepository'
import { createAutomationTurnRepository } from '../../storage/automationTurnRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunInputRepository } from '../../storage/runInputRepository'
import { createRunRepository } from '../../storage/runRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { AgentTaskAutomationAction } from '../AgentTaskAutomationAction'
import { AutomationDispatcher } from '../AutomationDispatcher'
import { AutomationService } from '../AutomationService'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('automationDispatcher', () => {
  it('binds and runs the frozen snapshot through a background Buddy turn', async () => {
    const fixture = createFixture()
    const occurrence = fixture.queue({
      executionProfile: 'full_access',
      model: { mode: 'default' },
    })
    const launches: string[] = []
    const dispatcher = fixture.dispatcher({
      async launchTurn(runId) {
        launches.push(runId)
        fixture.runs.markRunning(runId, '2026-08-24T00:00:11.000Z')
        fixture.runs.reconcileTerminal(runId, 'completed', '2026-08-24T00:00:20.000Z', null)
        return { completion: Promise.resolve(fixture.runs.findById(runId)!), runId }
      },
    })

    await dispatcher.dispatch(occurrence)

    expect(launches).toEqual([fixture.runs.listRecent()[0]!.id])
    expect(fixture.runInputs.findByRunId(launches[0]!)).toMatchObject({
      prompt: 'Run automation',
    })
    expect(fixture.service.getOccurrence(occurrence.id)).toMatchObject({
      conversationId: expect.any(String),
      runId: expect.any(String),
      status: 'bound',
    })
    expect(fixture.conversations.listRecent()).toEqual([
      expect.objectContaining({
        automationOccurrence: expect.objectContaining({
          automationId: occurrence.automationId,
          occurrenceId: occurrence.id,
          scheduledFor: occurrence.scheduledFor,
        }),
        origin: 'automation',
        title: 'Automation',
      }),
    ])
    expect(fixture.runs.listRecent()[0]).toMatchObject({
      executionProfile: 'full_access',
      purpose: 'automation',
      status: 'completed',
    })
  })

  it('blocks persistent pinned-model failures without creating a run', async () => {
    const fixture = createFixture()
    const occurrence = fixture.queue({
      model: {
        mode: 'pinned',
        modelId: 'missing-model',
        providerId: 'missing-provider',
        reasoning: null,
      },
    })
    const launchTurn = vi.fn()
    const dispatcher = fixture.dispatcher({
      launchTurn,
      resolveModel: async () => null,
    })

    await dispatcher.dispatch(occurrence)

    expect(launchTurn).not.toHaveBeenCalled()
    expect(fixture.service.getOccurrence(occurrence.id)).toMatchObject({
      errorCode: 'AUTOMATION_PINNED_MODEL_UNAVAILABLE',
      status: 'skipped',
    })
    expect(fixture.service.get(occurrence.automationId)).toMatchObject({
      blockedReason: 'AUTOMATION_PINNED_MODEL_UNAVAILABLE',
      status: 'blocked',
    })
    expect(fixture.runs.listRecent()).toEqual([])
  })

  it('blocks a missing Space but keeps a temporary default-model failure active', async () => {
    const spaceFixture = createFixture()
    const spaceOccurrence = spaceFixture.queue({
      model: { mode: 'default' },
      spaceId: 'missing-space',
    })
    const spaceLaunch = vi.fn()
    await spaceFixture.dispatcher({
      launchTurn: spaceLaunch,
      resolveSpace: async () => null,
    }).dispatch(spaceOccurrence)

    expect(spaceLaunch).not.toHaveBeenCalled()
    expect(spaceFixture.service.getOccurrence(spaceOccurrence.id)).toMatchObject({
      errorCode: 'AUTOMATION_SPACE_UNAVAILABLE',
      status: 'skipped',
    })
    expect(spaceFixture.service.get(spaceOccurrence.automationId)).toMatchObject({
      blockedReason: 'AUTOMATION_SPACE_UNAVAILABLE',
      status: 'blocked',
    })

    const modelFixture = createFixture()
    const modelOccurrence = modelFixture.queue({ model: { mode: 'default' } })
    const modelLaunch = vi.fn()
    await modelFixture.dispatcher({
      launchTurn: modelLaunch,
      resolveModel: async () => null,
    }).dispatch(modelOccurrence)

    expect(modelLaunch).not.toHaveBeenCalled()
    expect(modelFixture.service.getOccurrence(modelOccurrence.id)).toMatchObject({
      errorCode: 'AUTOMATION_DEFAULT_MODEL_UNAVAILABLE',
      status: 'skipped',
    })
    expect(modelFixture.service.get(modelOccurrence.automationId)?.status).toBe('active')
  })

  it('does not replay an occurrence after a run binding exists', async () => {
    const fixture = createFixture()
    const occurrence = fixture.queue({ model: { mode: 'default' } })
    const launchTurn = vi.fn(async (runId: string) => ({
      completion: Promise.resolve(fixture.runs.findById(runId)!),
      runId,
    }))
    const dispatcher = fixture.dispatcher({ launchTurn })

    await dispatcher.dispatch(occurrence)
    await dispatcher.dispatch(occurrence)

    expect(launchTurn).toHaveBeenCalledTimes(1)
    expect(fixture.runs.listRecent()).toHaveLength(1)
  })

  it('cancels an automation run with the stable timeout code', async () => {
    const fixture = createFixture()
    const occurrence = fixture.queue({ model: { mode: 'default' } })
    let complete!: (value: NonNullable<ReturnType<typeof fixture.runs.findById>>) => void
    const completion = new Promise<NonNullable<ReturnType<typeof fixture.runs.findById>>>((resolve) => {
      complete = resolve
    })
    const cancelRun = vi.fn(async (runId: string, errorCode: string) => {
      fixture.runs.reconcileTerminal(
        runId,
        'cancelled',
        '2026-08-24T00:01:00.000Z',
        errorCode,
      )
      complete(fixture.runs.findById(runId)!)
      return true
    })
    const dispatcher = fixture.dispatcher({
      cancelRun,
      launchTurn: async (runId) => {
        fixture.runs.markRunning(runId, '2026-08-24T00:00:11.000Z')
        return { completion, runId }
      },
      runTimeoutMs: 5,
    })

    await dispatcher.dispatch(occurrence)

    expect(cancelRun).toHaveBeenCalledWith(expect.any(String), 'AUTOMATION_RUN_TIMEOUT')
    expect(fixture.runs.listRecent()[0]).toMatchObject({
      errorCode: 'AUTOMATION_RUN_TIMEOUT',
      status: 'cancelled',
    })
  })

  it('binds one conversation and run when the same occurrence is dispatched concurrently', async () => {
    const fixture = createFixture()
    const occurrence = fixture.queue({ model: { mode: 'default' } })
    const modelReady = Promise.withResolvers<void>()
    const resolvingModel = Promise.withResolvers<void>()
    const dispatcher = fixture.dispatcher({
      resolveModel: async () => {
        resolvingModel.resolve()
        await modelReady.promise
        return { contextWindow: 200_000, maxTokens: 32_000, modelId: 'model-1', providerId: 'provider-1', reasoning: null }
      },
      launchTurn: async (runId) => {
        fixture.runs.markRunning(runId, '2026-08-24T00:00:11.000Z')
        fixture.runs.reconcileTerminal(runId, 'completed', '2026-08-24T00:00:20.000Z', null)
        return { completion: Promise.resolve(fixture.runs.findById(runId)!), runId }
      },
    })

    const first = dispatcher.dispatch(occurrence)
    await resolvingModel.promise
    const second = dispatcher.dispatch(occurrence)
    modelReady.resolve()
    await Promise.all([first, second])

    expect(fixture.conversations.listRecent()).toHaveLength(1)
    expect(fixture.runs.listRecent()).toHaveLength(1)
    expect(fixture.runs.listRecent()[0]).toMatchObject({ status: 'completed', purpose: 'automation' })
    expect(fixture.service.getOccurrence(occurrence.id)).toMatchObject({
      conversationId: fixture.conversations.listRecent()[0]!.id,
      runId: fixture.runs.listRecent()[0]!.id,
      status: 'bound',
    })
  })
})

function createFixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const service = new AutomationService({
    clock: { now: () => Temporal.Instant.from('2026-08-24T00:00:00.000Z') },
    createId: incrementalIds('automation'),
    repositories: createAutomationRepositories(database),
  })
  const conversations = createConversationRepository(database)
  const spaces = createSpaceRepository(database)
  const runInputs = createRunInputRepository(database)
  const runs = createRunRepository(database)
  const queue = (input: {
    executionProfile?: 'full_access' | 'workspace_write'
    model: AutomationModelTarget
    spaceId?: string | null
  }) => {
    if (input.spaceId && !spaces.findById(input.spaceId)) {
      spaces.create(spaceInput(input.spaceId))
    }
    const automation = service.create({
      draft: {
        executionProfile: input.executionProfile ?? 'workspace_write',
        model: input.model,
        name: 'Automation',
        spaceId: input.spaceId ?? null,
        prompt: 'Run automation',
        timing: {
          activeFrom: null,
          activeUntil: null,
          schedule: { cadence: 'daily', kind: 'calendar', localTime: '09:30' },
          timezone: 'Asia/Shanghai',
        },
      },
      requestId: `create-${input.model.mode}`,
    })
    service.runNow({
      automationId: automation.id,
      expectedRevision: automation.revision,
      requestId: `run-${input.model.mode}`,
    })
    return service.leaseQueued({
      leaseExpiresAt: '2026-08-24T00:01:00.000Z',
      limit: 1,
      now: '2026-08-24T00:00:00.000Z',
      owner: 'scheduler-1',
    })[0]!
  }
  return {
    conversations,
    dispatcher: (overrides: {
      cancelRun?: (runId: string, errorCode: string) => Promise<boolean>
      launchTurn: (runId: string) => Promise<{
        completion: Promise<ReturnType<typeof runs.findById> & {}>
        runId: string
      }>
      resolveModel?: () => Promise<{
        contextWindow: number
        maxTokens: number
        modelId: string
        providerId: string
        reasoning: null
      } | null>
      resolveSpace?: ConstructorParameters<typeof AgentTaskAutomationAction>[0]['resolveSpace']
      runTimeoutMs?: number
    }) => new AutomationDispatcher(service, new AgentTaskAutomationAction({
      automationService: service,
      cancelRun: overrides.cancelRun,
      clock: { now: () => Temporal.Instant.from('2026-08-24T00:00:10.000Z') },
      createId: incrementalIds('turn'),
      launchTurn: overrides.launchTurn,
      resolveModel: overrides.resolveModel ?? (async () => ({
        contextWindow: 200_000,
        maxTokens: 32_000,
        modelId: 'model-1',
        providerId: 'provider-1',
        reasoning: null,
      })),
      resolveSpace: overrides.resolveSpace ?? ((spaceId, executionContext) => {
        const space = spaces.findById(spaceId)
        return space && space.revokedAt === null
          ? { executionContext, id: space.id, status: 'ready' }
          : null
      }),
      runTimeoutMs: overrides.runTimeoutMs,
      turns: createAutomationTurnRepository(database),
    })),
    queue,
    runInputs,
    runs,
    service,
  }
}

function spaceInput(id: string) {
  const createdAt = '2026-08-24T00:00:00.000Z'
  const root = `/spaces/${id}`
  return {
    additionalDirectories: [],
    createdAt,
    id,
    memoryScope: 'space_only' as const,
    name: 'Space',
    primaryDirectory: {
      accessGrantedAt: createdAt,
      canonicalRoot: root,
      id: `directory-${id}`,
      resourcesTrustedAt: createdAt,
      root,
    },
  }
}

function incrementalIds(prefix: string): () => string {
  let next = 0
  return () => `${prefix}-${++next}`
}
