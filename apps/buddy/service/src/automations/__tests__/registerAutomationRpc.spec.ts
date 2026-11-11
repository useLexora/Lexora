import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import type { RuntimeRequestRegistrar } from '../../rpc/runtimeRequest'
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
  it('projects public occurrence fields and rejects invalid requests', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const clock = { now: () => Temporal.Instant.from('2026-08-24T00:00:00.000Z') }
    const service = new AutomationService({
      clock,
      repositories: createAutomationRepositories(database),
    })
    const changes = new AutomationChangeCoordinator({
      notify: () => {},
      service,
      wakeScheduler: () => {},
    })
    const lifecycle = new AutomationOccurrenceLifecycleService({
      automations: service,
      conversationLifecycle: { delete: async () => false, recover: async () => false },
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
    const runNow = automationRunNowResultSchema.parse(
      await harness.invoke('automations.runNow', {
        automationId: created.id,
        expectedRevision: created.revision,
        requestId: 'run-now-1',
      }),
    )
    expect(runNow.outcome).toBe('started')

    const history = automationOccurrencePageSchema.parse(
      await harness.invoke('automations.listOccurrences', {
        automationId: created.id,
        limit: 20,
      }),
    )
    expect(history.items).toEqual([
      expect.objectContaining({
        automationId: created.id,
        automationName: 'Original',
        effectiveStatus: 'queued',
        pendingApprovalCount: 0,
      }),
    ])

    await expect(harness.invoke('automations.list', { unexpected: true }))
      .rejects
      .toMatchObject({ code: 'VALIDATION_FAILED' })

    unregister()
  })
})

function createRpcHarness() {
  const handlers = new Map<string, RuntimeRequestHandler>()
  const rpc: RuntimeRequestRegistrar = {
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
