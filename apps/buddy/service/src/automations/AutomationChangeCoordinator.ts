import type { Automation } from '../../../shared/automation'
import type { EventSubscription } from '../../../shared/events/eventTypes'
import type { RunEventObservation } from '../events/RunEventPorts'
import type { RunLifecycleService } from '../runs/RunLifecycleService'
import type { RunRepository } from '../storage/runRepository'
import type { AutomationCommit } from './AutomationEvents'
import type { AutomationService } from './AutomationService'
import type { AutomationTurnService } from './AutomationTurnService'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { affectsAutomationSchedule } from './AutomationEvents'

export interface AutomationChangeCoordinatorOptions {
  notify: (automationId: string) => void
  service: Pick<AutomationService, 'blockPinnedModel' | 'blockSpace' | 'list' | 'onDidCommit' | 'getOccurrenceByConversationId'>
  turns?: Pick<AutomationTurnService, 'onDidCommit'>
  runChanges?: { eventLog: Pick<RunEventObservation, 'onDidCommit'>, lifecycle: Pick<RunLifecycleService, 'onDidReconcile'>, runs: Pick<RunRepository, 'findById'> }
  onError?: (error: unknown) => void
  wakeScheduler: () => Promise<void> | void | undefined
}

export interface AutomationDependencyAvailability {
  isPinnedModelAvailable: (providerId: string, modelId: string) => boolean
  isSpaceAvailable: (spaceId: string) => boolean
}

export class AutomationChangeCoordinator {
  readonly #subscriptions: EventSubscription[] = []
  readonly #pending = new Set<Promise<unknown>>()
  readonly #changes: Emitter<Readonly<{ automationId: string }>>
  readonly onDidChange: Emitter<Readonly<{ automationId: string }>>['event']
  readonly #onError: (error: unknown) => void
  #health: 'ready' | 'degraded' | 'stopped' = 'ready'
  #stopping = false
  #wakeBatch = 0
  #wakeNeeded = false
  #wakeFailed = false
  readonly #pendingRuns = new Set<string>()
  readonly #runChanges: AutomationChangeCoordinatorOptions['runChanges']
  readonly #service: AutomationChangeCoordinatorOptions['service']
  readonly #wakeScheduler: AutomationChangeCoordinatorOptions['wakeScheduler']

  constructor(options: AutomationChangeCoordinatorOptions) {
    this.#onError = options.onError ?? (() => {})
    this.#changes = new Emitter(this.#onError)
    this.onDidChange = this.#changes.event
    this.#subscriptions.push(this.onDidChange(event => options.notify(event.automationId)))
    this.#service = options.service
    this.#wakeScheduler = options.wakeScheduler
    this.#subscriptions.push(options.service.onDidCommit(event => this.#consume(event)))
    if (options.turns)
      this.#subscriptions.push(options.turns.onDidCommit(event => this.#consume(event)))
    this.#runChanges = options.runChanges
    const changes = this.#runChanges
    if (changes) {
      const changedRun = (runId: string) => {
        this.#pendingRuns.add(runId)
        this.reconcile()
      }
      this.#subscriptions.push(changes.eventLog.onDidCommit((event) => {
        if (event.type.startsWith('run.') || event.type === 'approval.requested' || event.type === 'approval.resolved')
          changedRun(event.runId)
      }), changes.lifecycle.onDidReconcile(event => changedRun(event.runId)))
    }
  }

  blockPinnedModel(providerId: string, modelId?: string): Automation[] {
    return this.#service.blockPinnedModel(providerId, modelId)
  }

  blockSpace(spaceId: string): Automation[] {
    return this.#service.blockSpace(spaceId)
  }

  reconcileDependencies(availability: AutomationDependencyAvailability): Automation[] {
    this.#wakeBatch++
    try {
      return this.#reconcileDependencies(availability)
    }
    finally {
      this.#wakeBatch--
      if (!this.#wakeBatch && this.#wakeNeeded)
        this.wakeScheduler()
    }
  }

  #reconcileDependencies(availability: AutomationDependencyAvailability): Automation[] {
    const active = this.#listActive()
    const blocked = new Map<string, Automation>()
    const blockedSpaces = new Set<string>()
    const blockedModels = new Set<string>()

    for (const automation of active) {
      if (
        automation.spaceId
        && !availability.isSpaceAvailable(automation.spaceId)
        && !blockedSpaces.has(automation.spaceId)
      ) {
        blockedSpaces.add(automation.spaceId)
        for (const item of this.#service.blockSpace(automation.spaceId))
          blocked.set(item.id, item)
        continue
      }
      if (automation.model.mode !== 'pinned')
        continue
      if (availability.isPinnedModelAvailable(
        automation.model.providerId,
        automation.model.modelId,
      )) {
        continue
      }
      const modelKey = `${automation.model.providerId}\0${automation.model.modelId}`
      if (blockedModels.has(modelKey))
        continue
      blockedModels.add(modelKey)
      for (const item of this.#service.blockPinnedModel(
        automation.model.providerId,
        automation.model.modelId,
      )) {
        blocked.set(item.id, item)
      }
    }

    return [...blocked.values()]
  }

  get state() { return this.#health }

  reconcile(): void {
    const changes = this.#runChanges
    if (!changes)
      return
    for (const runId of this.#pendingRuns) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const run = changes.runs.findById(runId)
          const occurrence = run ? this.#service.getOccurrenceByConversationId(run.conversationId) : null
          this.#pendingRuns.delete(runId)
          if (occurrence)
            this.#notify(occurrence.automationId)
          break
        }
        catch (error) {
          if (attempt === 2)
            this.#fail(error)
        }
      }
    }
    this.#updateHealth()
  }

  #updateHealth(): void {
    if (!this.#stopping)
      this.#health = this.#wakeFailed || this.#pendingRuns.size ? 'degraded' : 'ready'
  }

  wakeScheduler(): void {
    if (this.#stopping)
      return
    this.reconcile()
    this.#wakeNeeded = true
    if (this.#wakeBatch)
      return
    this.#wakeNeeded = false
    try {
      const pending = Promise.resolve(this.#wakeScheduler()).then(() => {
        this.#wakeFailed = false
        this.#updateHealth()
      }, (error) => {
        this.#wakeFailed = true
        this.#fail(error)
      }).finally(() => this.#pending.delete(pending))
      this.#pending.add(pending)
    }
    catch (error) {
      this.#wakeFailed = true
      this.#fail(error)
    }
  }

  async whenIdle(): Promise<void> {
    while (this.#pending.size)
      await Promise.allSettled([...this.#pending])
  }

  async dispose(): Promise<void> {
    this.#stopping = true
    await this.whenIdle()
    this.reconcile()
    for (const subscription of this.#subscriptions.splice(0)) subscription.dispose()
    this.#health = 'stopped'
    this.#changes.dispose()
  }

  #consume(event: AutomationCommit): void {
    this.reconcile()
    for (const automationId of new Set(event.facts.map(fact => fact.automationId)))
      this.#notify(automationId)
    if (affectsAutomationSchedule(event))
      this.wakeScheduler()
  }

  #notify(automationId: string): void {
    this.#changes.fire(copyEventSnapshot({ automationId }))
  }

  #fail(error: unknown): void {
    if (!this.#stopping)
      this.#health = 'degraded'
    try {
      this.#onError(error)
    }
    catch {}
  }

  #listActive(): Automation[] {
    const active: Automation[] = []
    let cursor: string | null = null
    do {
      const page = this.#service.list({
        cursor,
        limit: 100,
        statuses: ['active'],
      })
      active.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    return active
  }
}
