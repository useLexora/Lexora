import type { LocalTaskMark, LocalTaskMarkState } from '../../../shared/conversation/taskMarkApi'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { RunEventObservation } from '../events/RunEventPorts'
import type { RunLifecycleService } from '../runs/RunLifecycleService'
import type { RunRepository } from '../storage/runRepository'
import type { TaskMarkRepository } from '../storage/taskMarkRepository'
import type { ConversationLifecycleService } from './ConversationLifecycleService'
import type { TaskMarkService } from './TaskMarkService'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export type TaskAttentionChange = EventSnapshot<{
  revision: number
  conversationIds: string[]
  marksChanged: boolean
}>

export interface TaskAttentionProjectionOptions {
  marks: Pick<TaskMarkService, 'onDidCommit'>
  eventLog: Pick<RunEventObservation, 'onDidCommit'>
  repository: Pick<TaskMarkRepository, 'allStates' | 'states' | 'list'>
  runs: Pick<RunRepository, 'findById'>
  onError: (error: unknown) => void
}

export class TaskAttentionProjection {
  readonly #options: TaskAttentionProjectionOptions
  readonly #changed: Emitter<TaskAttentionChange>
  readonly #subscriptions: { dispose: () => void }[]
  readonly #states = new Map<string, LocalTaskMarkState>()
  readonly onDidChange: Emitter<TaskAttentionChange>['event']
  #marks: readonly LocalTaskMark[] = []
  #health: 'starting' | 'ready' | 'degraded' | 'stopped' = 'starting'
  #revision = 0

  constructor(options: TaskAttentionProjectionOptions) {
    this.#options = options
    this.#changed = new Emitter(options.onError)
    this.onDidChange = this.#changed.event
    this.#subscriptions = [
      options.marks.onDidCommit(event => this.#consume(() => this.#refresh(event.kind === 'attention' ? [event.conversationId] : event.kind === 'deleted' ? event.conversationIds : []))),
      options.eventLog.onDidCommit((event) => {
        if (event.type !== 'run.completed' && event.type !== 'run.failed')
          return
        this.#consume(() => {
          const run = options.runs.findById(event.runId)
          if (run && run.purpose !== 'conversation.compaction')
            this.#refresh([run.conversationId])
        })
      }),
    ]
  }

  get state() {
    return this.#health
  }

  start(deletions: Pick<ConversationLifecycleService, 'onDidCommit'>, reconciliations?: Pick<RunLifecycleService, 'onDidReconcile'>): void {
    this.#subscriptions.push(deletions.onDidCommit(event => this.#consume(() => this.#refresh([event.conversationId]))))
    if (reconciliations)
      this.#subscriptions.push(reconciliations.onDidReconcile(event => this.#consume(() => this.#refresh([event.conversationId]))))
    this.reconcile()
  }

  reconcile(): void {
    if (this.#health === 'stopped')
      return
    try {
      this.#refresh()
      this.#health = 'ready'
    }
    catch (error) {
      this.#health = 'degraded'
      throw error
    }
  }

  list(): readonly LocalTaskMark[] {
    this.#requireReady()
    return this.#marks
  }

  states(conversationIds: readonly string[]): LocalTaskMarkState[] {
    this.#requireReady()
    try {
      this.#refresh(conversationIds)
    }
    catch (error) {
      this.#health = 'degraded'
      throw error
    }
    return conversationIds.flatMap(id => this.#states.get(id) ?? [])
  }

  dispose(): void {
    this.#health = 'stopped'
    for (const subscription of this.#subscriptions)
      subscription.dispose()
    this.#changed.dispose()
    this.#states.clear()
    this.#marks = []
  }

  #requireReady(): void {
    if (this.#health === 'stopped')
      throw new Error('Task attention projection is stopped')
    if (this.#health !== 'ready')
      this.reconcile()
  }

  #consume(operation: () => void): void {
    if (this.#health === 'stopped')
      return
    try {
      if (this.#health !== 'ready')
        this.reconcile()
      else operation()
    }
    catch (error) {
      this.#health = 'degraded'
      this.#options.onError(error)
    }
  }

  #refresh(conversationIds?: readonly string[]): void {
    const rows = conversationIds ? this.#options.repository.states(conversationIds) : this.#options.repository.allStates()
    const states = new Map(rows.map(state => [state.conversationId, copyEventSnapshot(state)]))
    const changed: string[] = []
    const targets = conversationIds ?? [...new Set([...this.#states.keys(), ...states.keys()])]
    const marks = copyEventSnapshot(this.#options.repository.list())
    const marksChanged = JSON.stringify(this.#marks) !== JSON.stringify(marks)
    for (const id of targets) {
      const next = states.get(id)
      if (JSON.stringify(this.#states.get(id)) === JSON.stringify(next))
        continue
      changed.push(id)
      if (next)
        this.#states.set(id, next)
      else this.#states.delete(id)
    }
    this.#marks = marks
    if (changed.length || marksChanged) {
      this.#revision += 1
      this.#changed.fire(copyEventSnapshot({ revision: this.#revision, conversationIds: changed, marksChanged }))
    }
  }
}
