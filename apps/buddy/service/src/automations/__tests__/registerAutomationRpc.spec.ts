import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import type { RuntimeRpcRegistrar } from '../../rpc/runtimeRequest'
import { afterEach, describe, expect, it } from 'vitest'
import {
  automationOccurrencePageSchema,
  automationRunNowResultSchema,
} from '../../../../shared/automation'

import { createAutomationRepositories } from '../../storage/automationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { AutomationChangeCoordinator } from '../AutomationChangeCoordinator'
import { AutomationOccurrenceLifecycleService } from '../AutomationOccurrenceLifecycleService'
import { AutomationService } from '../AutomationService'
import { registerAutomationRpc } from '../registerAutomationRpc'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

describe('registerAutomationRpc', () => {
  it('owns mutation, public occurrence projection, validation and wake notifications', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const clock = { now: () => Temporal.Instant.from('2026-08-24T00:00:00.000Z') }
    const service = new AutomationService({
      clock,
      createId: incrementalIds('automation'),
      repositories: createAutomationRepositories(database),
    })
    const published: string[] = []
    let wakeCount = 0
    const changes = new AutomationChangeCoordinator({
      notify: automationId => published.push(automationId),
      service,
      wakeScheduler: () => {
        wakeCount += 1
      },
    })
    const lifecycle = new AutomationOccurrenceLifecycleService({
      automations: service,
      conversationLifecycle: { delete: async () => false },
      notifications: { removeAutomationRun: () => false },
    })
    const harness = createRpcHarness()
    const unregister = registerAutomationRpc({
      approvals: { listPending: () => [] },
      changes,
      clock,
      lifecycle,
      rpc: harness.rpc,
      runs: { findById: () => null },
      service,
    })

    const created = await harness.invoke('automations.create', {
      draft: dailyDraft('Original'),
      requestId: 'create-1',
    }) as { id: string, revision: number }
    const updated = await harness.invoke('automations.update', {
      automationId: created.id,
      draft: dailyDraft('Updated'),
      expectedRevision: created.revision,
      requestId: 'update-1',
    }) as { id: string, revision: number }
    const runNow = automationRunNowResultSchema.parse(
      await harness.invoke('automations.runNow', {
        automationId: updated.id,
        expectedRevision: updated.revision,
        requestId: 'run-now-1',
      }),
    )
    expect(runNow.outcome).toBe('started')
    expect(JSON.stringify(runNow)).not.toContain('executionSnapshot')
    expect(JSON.stringify(runNow)).not.toContain('dedupeKey')

    const repeated = automationRunNowResultSchema.parse(
      await harness.invoke('automations.runNow', {
        automationId: updated.id,
        expectedRevision: updated.revision,
        requestId: 'run-now-2',
      }),
    )
    expect(repeated).toMatchObject({
      occurrence: { id: runNow.occurrence.id },
      outcome: 'already_running',
    })
    const history = automationOccurrencePageSchema.parse(
      await harness.invoke('automations.listOccurrences', {
        automationId: updated.id,
        limit: 20,
      }),
    )
    expect(history.items).toEqual([
      expect.objectContaining({
        automationId: updated.id,
        automationName: 'Updated',
        effectiveStatus: 'queued',
        pendingApprovalCount: 0,
      }),
    ])

    const paused = await harness.invoke('automations.pause', {
      automationId: updated.id,
      expectedRevision: updated.revision,
      requestId: 'pause-1',
    }) as { revision: number, status: string }
    expect(paused).toMatchObject({ revision: 3, status: 'paused' })
    const resumed = await harness.invoke('automations.resume', {
      automationId: updated.id,
      expectedRevision: paused.revision,
      requestId: 'resume-1',
    }) as { revision: number, status: string }
    expect(resumed).toMatchObject({ revision: 4, status: 'active' })
    await expect(harness.invoke('automations.deleteOccurrence', {
      occurrenceId: runNow.occurrence.id,
    })).resolves.toBe(true)
    await expect(harness.invoke('automations.delete', {
      automationId: updated.id,
      expectedRevision: resumed.revision,
      requestId: 'delete-1',
    })).resolves.toMatchObject({ revision: 5, status: 'completed' })
    await expect(harness.invoke('automations.get', { automationId: updated.id }))
      .rejects
      .toMatchObject({ code: 'AUTOMATION_NOT_FOUND' })
    await expect(harness.invoke('automations.list', { unexpected: true }))
      .rejects
      .toMatchObject({ code: 'VALIDATION_FAILED' })

    expect(published).toEqual([
      created.id,
      created.id,
      created.id,
      created.id,
      created.id,
      created.id,
      created.id,
    ])
    expect(wakeCount).toBe(6)
    harness.notify('scheduler.wake', { reason: 'resume' })
    harness.notify('scheduler.wake', { reason: 'invalid' })
    expect(wakeCount).toBe(7)

    unregister()
    expect(harness.notificationListenerCount()).toBe(0)
  })
})

function createRpcHarness() {
  const handlers = new Map<string, RuntimeRequestHandler>()
  const notificationListeners = new Set<(method: string, params: unknown) => void>()
  const rpc: RuntimeRpcRegistrar = {
    onNotification(listener) {
      notificationListeners.add(listener)
      return () => notificationListeners.delete(listener)
    },
    onRequest(method, handler) {
      handlers.set(method, handler)
      return () => handlers.delete(method)
    },
  }
  return {
    async invoke(method: string, params: unknown) {
      const handler = handlers.get(method)
      if (!handler)
        throw new Error(`Missing handler: ${method}`)
      return await handler(params)
    },
    notificationListenerCount: () => notificationListeners.size,
    notify(method: string, params: unknown) {
      for (const listener of notificationListeners)
        listener(method, params)
    },
    rpc,
  }
}

function dailyDraft(name: string) {
  return {
    executionProfile: 'workspace_write' as const,
    model: { mode: 'default' as const },
    name,
    spaceId: null,
    prompt: 'Run automation',
    timing: {
      activeFrom: null,
      activeUntil: null,
      schedule: { cadence: 'daily' as const, kind: 'calendar' as const, localTime: '12:00' },
      timezone: 'Asia/Shanghai',
    },
  }
}

function incrementalIds(prefix: string): () => string {
  let next = 0
  return () => `${prefix}-${++next}`
}
