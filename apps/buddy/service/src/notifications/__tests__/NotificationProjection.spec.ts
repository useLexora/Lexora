import type { AutomationCommit } from '../../automations/AutomationEvents'
import type { BuddyRunEvent } from '../../events/BuddyRunEvent'
import type { ProviderCommit } from '../../providers/ProviderState'
import type { RunSqlReconciliation } from '../../runs/RunLifecycleService'
import { describe, expect, it } from 'vitest'
import { Emitter } from '../../../../shared/events/Emitter'
import { openBuddyDatabase } from '../../storage/database'
import { createNotificationAttentionRepository } from '../../storage/notificationAttentionRepository'
import { AttentionNotificationService } from '../AttentionNotificationService'
import { NotificationProjection } from '../NotificationProjection'

function sources() {
  const providers = new Emitter<ProviderCommit>(() => {})
  const automations = new Emitter<AutomationCommit>(() => {})
  const runs = new Emitter<BuddyRunEvent>(() => {})
  const lifecycle = new Emitter<RunSqlReconciliation>(() => {})
  return { providers, automations, runs, lifecycle, options: { providers: { onDidCommit: providers.event }, automations: { onDidCommit: automations.event }, runs: { onDidCommit: runs.event, state: 'open' as const }, lifecycle: { onDidReconcile: lifecycle.event } } }
}

describe('notification projection', () => {
  it('reconciles terminal sources without an RPC and stops receiving after drain', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const sources_ = sources()
    const runs = [{ automationId: 'automation', automationName: 'Fixture', completedAt: '2026-09-28T00:00:00.000Z', conversationId: 'conversation', errorCode: null, runId: 'run', status: 'completed' as const }]
    const service = new AttentionNotificationService({ attention: createNotificationAttentionRepository(database), listModels: () => [], listAutomationRuns: () => runs, now: () => '2026-09-28T00:00:01.000Z' })
    const projection = new NotificationProjection({ ...sources_.options, service, record: () => {} })
    try {
      await projection.whenIdle()
      expect(service.snapshot.unseenCount).toBe(1)
      runs[0]!.automationName = 'Updated'
      sources_.automations.fire({ operationId: 'operation', revision: 1, facts: [{ kind: 'occurrence.finished', automationId: 'automation', occurrenceId: 'occurrence', status: 'skipped', errorCode: null }] })
      await projection.dispose()
      expect(service.snapshot.items[0]?.payload).toMatchObject({ automationName: 'Updated' })
      expect(projection.snapshot.status).toBe('stopped')
      runs[0]!.automationName = 'After disposal'
      sources_.lifecycle.fire({ runId: 'run', conversationId: 'conversation', branchId: 'branch', status: 'failed', errorCode: 'EVENT_LOG_FAILED', completedAt: '2026-09-28T00:00:02.000Z' })
      await Promise.resolve()
      expect(service.snapshot.items[0]?.payload).toMatchObject({ automationName: 'Updated' })
    }
    finally {
      await projection.dispose()
      service.dispose()
      database.close()
    }
  })

  it('drains a fact arriving between a completed reconciliation and its promise cleanup', async () => {
    const source = sources()
    let current = 'initial'
    const applied: string[] = []
    const projection = new NotificationProjection({ ...source.options, service: { reconcile: () => {
      applied.push(current)
      if (current === 'initial') {
        queueMicrotask(() => {
          current = 'late commit'
          source.lifecycle.fire({ runId: 'run', conversationId: 'conversation', branchId: 'branch', status: 'failed', errorCode: 'EVENT_LOG_FAILED', completedAt: '2026-09-28T00:00:02.000Z' })
        })
      }
    } }, record: () => {} })
    await projection.whenIdle()
    expect(applied).toEqual(['initial', 'late commit'])
    expect(projection.snapshot.status).toBe('ready')
    await projection.dispose()
  })

  it('bounds failed reconciliation and allows explicit recovery with no false current state', async () => {
    const source = sources()
    let unavailable = true
    let attempts = 0
    const projection = new NotificationProjection({ ...source.options, service: { reconcile: () => {
      attempts++
      if (unavailable)
        throw new Error('storage unavailable')
    } }, record: () => {} })
    await projection.whenIdle()
    expect(projection.snapshot.status).toBe('degraded')
    expect(attempts).toBe(3)
    unavailable = false
    projection.reconcile()
    await projection.whenIdle()
    expect(projection.snapshot.status).toBe('ready')
    await projection.dispose()
  })
})
