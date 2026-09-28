import type { ConversationLifecycleService } from '../conversations/ConversationLifecycleService'
import type { AttentionNotificationService } from '../notifications/AttentionNotificationService'
import type { AutomationService } from './AutomationService'
import { randomUUID } from 'node:crypto'
import { readDiagnosticErrorCode } from '../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export interface AutomationOccurrenceDeletionResult {
  automationId: string | null
  deleted: boolean
}

export interface AutomationOccurrenceLifecycleServiceOptions {
  automations: AutomationService
  conversationLifecycle: Pick<ConversationLifecycleService, 'delete'>
  notifications: Pick<AttentionNotificationService, 'removeAutomationRun'>
  onObserverError?: (error: unknown) => void
}

export type AutomationOccurrenceCleanup = Readonly<{ operationId: string, occurrenceId: string, automationId: string, conversationId: string | null, status: 'started' | 'completed' | 'failed', errorCode?: string }>

export class AutomationOccurrenceLifecycleService {
  readonly #automations: AutomationService
  readonly #conversationLifecycle: AutomationOccurrenceLifecycleServiceOptions['conversationLifecycle']
  readonly #notifications: AutomationOccurrenceLifecycleServiceOptions['notifications']
  readonly #cleanup: Emitter<AutomationOccurrenceCleanup>
  readonly #pending = new Map<string, Promise<AutomationOccurrenceDeletionResult>>()
  readonly #completed = new Set<string>()
  #stopping = false
  readonly onDidCleanup: Emitter<AutomationOccurrenceCleanup>['event']

  constructor(options: AutomationOccurrenceLifecycleServiceOptions) {
    this.#automations = options.automations
    this.#conversationLifecycle = options.conversationLifecycle
    this.#notifications = options.notifications
    this.#cleanup = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidCleanup = this.#cleanup.event
  }

  deleteConversation(conversationId: string): Promise<AutomationOccurrenceDeletionResult> {
    return this.#run(`conversation:${conversationId}`, async () => {
      const occurrence = this.#automations.getOccurrenceDeletionByConversation(conversationId)
      if (occurrence)
        return this.#deleteOccurrence(occurrence.id)
      return { automationId: null, deleted: await this.#conversationLifecycle.delete(conversationId) }
    })
  }

  deleteOccurrence(occurrenceId: string): Promise<AutomationOccurrenceDeletionResult> {
    const occurrence = this.#automations.getOccurrenceForDeletion(occurrenceId)
    return this.#run(occurrence?.conversationId ? `conversation:${occurrence.conversationId}` : `occurrence:${occurrenceId}`, () => this.#deleteOccurrence(occurrenceId))
  }

  async #deleteOccurrence(occurrenceId: string): Promise<AutomationOccurrenceDeletionResult> {
    const occurrence = this.#automations.getOccurrenceForDeletion(occurrenceId)
    if (!occurrence)
      return { automationId: null, deleted: false }
    if (this.#completed.has(occurrence.id))
      return { automationId: occurrence.automationId, deleted: false }
    const occurrenceDeleted = this.#automations.markOccurrenceDeleted(occurrence.id)
    const identity = { operationId: randomUUID(), occurrenceId: occurrence.id, automationId: occurrence.automationId, conversationId: occurrence.conversationId }
    this.#cleanup.fire(copyEventSnapshot({ ...identity, status: 'started' }))
    try {
      if (occurrence.runId)
        await this.#notifications.removeAutomationRun(occurrence.runId)
      const conversationDeleted = occurrence.conversationId
        ? await this.#conversationLifecycle.delete(occurrence.conversationId)
        : false
      this.#completed.add(occurrence.id)
      this.#cleanup.fire(copyEventSnapshot({ ...identity, status: 'completed' }))
      return { automationId: occurrence.automationId, deleted: occurrenceDeleted || conversationDeleted }
    }
    catch (error) {
      this.#cleanup.fire(copyEventSnapshot({ ...identity, status: 'failed', errorCode: readDiagnosticErrorCode(error) }))
      throw error
    }
  }

  async recoverPendingDeletions(): Promise<void> {
    for (const occurrence of this.#automations.listPendingDeletions())
      await this.deleteOccurrence(occurrence.id)
  }

  async dispose(): Promise<void> {
    this.#stopping = true
    await Promise.allSettled([...this.#pending.values()])
    this.#cleanup.dispose()
    this.#completed.clear()
  }

  #run(key: string, operation: () => Promise<AutomationOccurrenceDeletionResult>): Promise<AutomationOccurrenceDeletionResult> {
    if (this.#stopping)
      return Promise.reject(new Error('Automation occurrence lifecycle is stopped'))
    const previous = this.#pending.get(key)
    if (previous)
      return previous
    const accepted = Promise.withResolvers<AutomationOccurrenceDeletionResult>()
    this.#pending.set(key, accepted.promise)
    void accepted.promise.finally(() => this.#pending.delete(key)).catch(() => {})
    void operation().then(accepted.resolve, accepted.reject)
    return accepted.promise
  }
}
