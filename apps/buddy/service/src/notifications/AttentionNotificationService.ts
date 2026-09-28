import type {
  NotificationAttentionRecord,
  NotificationAttentionRepository,
} from '../storage/notificationAttentionRepository'
import type { ProviderModelStateRecord } from '../storage/providerModelStateRepository'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

const MODEL_UPDATE_NOTIFICATION_ID = 'local:model-source-parameters-updated'
const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000

export interface AutomationRunNotificationSource {
  automationId: string
  automationName: string
  completedAt: string
  conversationId: string
  errorCode: string | null
  runId: string
  status: 'completed' | 'failed'
}

interface ModelUpdateAttentionNotification {
  action: { type: 'open-model-settings' }
  attention: 'seen' | 'unseen'
  audience: 'device'
  id: string
  kind: 'model.source-parameters-updated'
  lifecycle: 'active' | 'resolved'
  occurredAt: string
  origin: 'local-runtime'
  payload: { modelCount: number }
  resolvedAt: string | null
  revision: string
}

interface AutomationRunAttentionNotification {
  action: {
    conversationId: string
    runId: string
    type: 'open-conversation'
  }
  attention: 'seen' | 'unseen'
  audience: 'device'
  id: string
  kind: 'automation.run.completed' | 'automation.run.failed'
  lifecycle: 'resolved'
  occurredAt: string
  origin: 'local-runtime'
  payload: {
    automationId: string
    automationName: string
    errorCode: string | null
  }
  resolvedAt: string
  revision: string
}

export type AttentionNotification
  = | AutomationRunAttentionNotification
    | ModelUpdateAttentionNotification

export interface AttentionNotificationList {
  items: AttentionNotification[]
  unseenCount: number
}

export interface AttentionNotificationServiceOptions {
  attention: NotificationAttentionRepository
  listAutomationRuns: () => AutomationRunNotificationSource[]
  listModels: () => ProviderModelStateRecord[]
  now?: () => string
}

export interface NotificationCommit {
  readonly revision: number
  readonly operationId: string
  readonly reason: 'reconcile' | 'seen' | 'removed'
  readonly changes: readonly { readonly id: string, readonly kind: 'added' | 'changed' | 'removed' }[]
  readonly unseenCount: number
}

export class AttentionNotificationService {
  readonly #commits = new Emitter<NotificationCommit>(() => console.error('NOTIFICATION_OBSERVER_FAILED'))
  readonly onDidCommit = this.#commits.event
  #revision = 0
  #disposed = false
  readonly #attention: NotificationAttentionRepository
  readonly #listAutomationRuns: () => AutomationRunNotificationSource[]
  readonly #listModels: () => ProviderModelStateRecord[]
  readonly #now: () => string

  constructor(options: AttentionNotificationServiceOptions) {
    this.#attention = options.attention
    this.#listAutomationRuns = options.listAutomationRuns
    this.#listModels = options.listModels
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  list(): AttentionNotificationList {
    this.reconcile()
    return this.#read()
  }

  get snapshot() { return copyEventSnapshot({ revision: this.#revision, ...this.#read() }) }

  reconcile(): void {
    this.#commit('reconcile', () => this.#reconcile())
  }

  markAllSeen(): AttentionNotificationList {
    this.#commit('seen', () => {
      const now = this.#now()
      this.#reconcile(now)
      this.#attention.markAllSeen(now)
    })
    return this.#read()
  }

  markSeen(notificationId: string, revision: string): AttentionNotificationList {
    this.#commit('seen', () => {
      const now = this.#now()
      this.#reconcile(now)
      this.#attention.markSeen(notificationId, revision, now)
    })
    return this.#read()
  }

  removeAutomationRun(runId: string): boolean {
    return this.#commit('removed', () => this.#attention.remove(`local:automation-run:${runId}`))
  }

  dispose(): void {
    this.#disposed = true
    this.#commits.dispose()
  }

  #read(): AttentionNotificationList {
    const items = this.#attention.list().filter(isApplicationNotification).map(toNotification).sort(compareNotifications)
    return { items, unseenCount: items.filter(item => item.attention === 'unseen').length }
  }

  #commit<T>(reason: NotificationCommit['reason'], work: () => T): T {
    if (this.#disposed)
      throw new Error('NOTIFICATIONS_DISPOSED')
    const before = new Map(this.#read().items.map(item => [item.id, item]))
    try {
      return work()
    }
    finally {
      const result = this.#read()
      const after = new Map(result.items.map(item => [item.id, item]))
      const changes: NotificationCommit['changes'][number][] = []
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)))
          changes.push({ id, kind: before.has(id) ? after.has(id) ? 'changed' : 'removed' : 'added' })
      }
      if (changes.length)
        this.#commits.fire(copyEventSnapshot({ revision: ++this.#revision, operationId: randomUUID(), reason, changes, unseenCount: result.unseenCount }))
    }
  }

  #reconcile(now = this.#now()): void {
    this.#reconcileModelUpdates(now)
    this.#reconcileAutomationRuns(now)
    this.#attention.pruneResolvedLocalBefore(
      new Date(Date.parse(now) - RETENTION_MILLISECONDS).toISOString(),
    )
  }

  #reconcileAutomationRuns(now: string): void {
    const cutoff = Date.parse(now) - RETENTION_MILLISECONDS
    for (const run of this.#listAutomationRuns()) {
      if (Date.parse(run.completedAt) < cutoff)
        continue
      this.#attention.observe({
        kind: `automation.run.${run.status}`,
        notificationId: `local:automation-run:${run.runId}`,
        observedAt: now,
        occurredAt: run.completedAt,
        origin: 'local-runtime',
        payload: {
          automationId: run.automationId,
          automationName: run.automationName,
          errorCode: run.errorCode,
          conversationId: run.conversationId,
          runId: run.runId,
        },
        resolvedAt: run.completedAt,
        revision: run.completedAt,
      })
    }
  }

  #reconcileModelUpdates(now: string): void {
    const pending = this.#listModels().filter(model => (
      model.overrideContextWindow !== null
      && model.overrideMaxTokens !== null
      && model.acknowledgedSourceRevision !== model.sourceRevision
    ))
    const current = this.#attention.findById(MODEL_UPDATE_NOTIFICATION_ID)
    if (pending.length === 0) {
      if (current?.resolvedAt === null)
        this.#attention.markResolved(MODEL_UPDATE_NOTIFICATION_ID, now)
      return
    }
    const latest = pending.reduce((value, model) => (
      model.sourceRevision > value.sourceRevision ? model : value
    ))
    const revision = current && current.revision > latest.sourceRevision
      ? current.revision
      : latest.sourceRevision
    this.#attention.observe({
      kind: 'model.source-parameters-updated',
      notificationId: MODEL_UPDATE_NOTIFICATION_ID,
      observedAt: now,
      occurredAt: Number.isNaN(Date.parse(latest.sourceRevision))
        ? latest.updatedAt
        : latest.sourceRevision,
      origin: 'local-runtime',
      payload: { modelCount: pending.length },
      resolvedAt: null,
      revision,
    })
  }
}

function compareNotifications(left: AttentionNotification, right: AttentionNotification): number {
  if (left.attention !== right.attention)
    return left.attention === 'unseen' ? -1 : 1
  if (left.lifecycle !== right.lifecycle)
    return left.lifecycle === 'active' ? -1 : 1
  return right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
}

function toNotification(record: NotificationAttentionRecord): AttentionNotification {
  if (record.kind === 'automation.run.completed' || record.kind === 'automation.run.failed') {
    const payload = record.payload as AutomationRunAttentionNotification['payload'] & {
      conversationId: string
      runId: string
    }
    return {
      action: {
        conversationId: payload.conversationId,
        runId: payload.runId,
        type: 'open-conversation',
      },
      attention: record.seenRevision === record.revision ? 'seen' as const : 'unseen' as const,
      audience: 'device' as const,
      id: record.notificationId,
      kind: record.kind,
      lifecycle: 'resolved' as const,
      occurredAt: record.occurredAt,
      origin: 'local-runtime' as const,
      payload: {
        automationId: payload.automationId,
        automationName: payload.automationName,
        errorCode: payload.errorCode,
      },
      resolvedAt: record.resolvedAt!,
      revision: record.revision,
    }
  }
  return {
    action: { type: 'open-model-settings' },
    attention: record.seenRevision === record.revision ? 'seen' as const : 'unseen' as const,
    audience: 'device' as const,
    id: record.notificationId,
    kind: 'model.source-parameters-updated',
    lifecycle: record.resolvedAt === null ? 'active' as const : 'resolved' as const,
    occurredAt: record.occurredAt,
    origin: 'local-runtime' as const,
    payload: record.payload as { modelCount: number },
    resolvedAt: record.resolvedAt,
    revision: record.revision,
  }
}

function isApplicationNotification(record: NotificationAttentionRecord): boolean {
  return record.kind === 'model.source-parameters-updated'
    || record.kind === 'automation.run.completed'
    || record.kind === 'automation.run.failed'
}
