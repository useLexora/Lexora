import type { EventSubscription } from '../../../shared/events/eventTypes'
import type { LocalConversationStatus } from '../../../shared/runs/conversationStatusApi'
import type { LocalTaskMetrics, TaskMetricsChanged, TaskMetricsRequest } from '../../../shared/runs/taskMetricsApi'
import type { RunEventObservation } from '../events/RunEventPorts'
import type { ConversationStatisticsRepository, ConversationStatisticsScope, ConversationStatisticsSnapshot } from '../storage/conversationStatisticsRepository'
import type { RunRepository } from '../storage/runRepository'
import { Emitter } from '../../../shared/events/Emitter'
import { conversationStatusRequestSchema } from '../../../shared/runs/conversationStatusApi'
import { taskMetricsRequestSchema } from '../../../shared/runs/taskMetricsApi'
import { BuddyServiceError, parse } from '../rpc/runtimeRequest'

export interface ConversationStatusOptions {
  repository: ConversationStatisticsRepository
  runs: Pick<RunRepository, 'findById'>
  events: Pick<RunEventObservation, 'onDidCommit'>
  getCacheWarmingStatus?: (conversationId: string) => LocalConversationStatus['cacheWarming']
}

const CACHE_LIMIT = 16
const CHANGE_WINDOW_MS = 120
const CHANGE_EVENTS = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'message.started',
  'message.block.started',
  'message.completed',
  'message.interrupted',
  'message.tool_result',
  'tool.preparing',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'tool.denied',
  'usage.recorded',
  'context.usage.updated',
  'context.compaction.started',
  'context.compaction.completed',
  'context.compaction.cancelled',
  'context.compaction.failed',
])

export class ConversationStatusService {
  readonly #options: ConversationStatusOptions
  readonly #cache = new Map<string, ConversationStatisticsSnapshot>()
  readonly #changes = new Emitter<TaskMetricsChanged>(() => {})
  readonly #subscription: EventSubscription
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>()
  readonly onDidChange = this.#changes.event
  #revision = 0
  #disposed = false

  constructor(options: ConversationStatusOptions) {
    this.#options = options
    this.#subscription = options.events.onDidCommit((event) => {
      if (!CHANGE_EVENTS.has(event.type))
        return
      const run = options.runs.findById(event.runId)
      if (run)
        this.notifyChanged(run.conversationId)
    })
  }

  notifyChanged(conversationId: string): void {
    if (this.#disposed || this.#pending.has(conversationId))
      return
    const timer = setTimeout(() => {
      this.#pending.delete(conversationId)
      this.#changes.fire(Object.freeze({ conversationId, revision: ++this.#revision }))
    }, CHANGE_WINDOW_MS)
    timer.unref()
    this.#pending.set(conversationId, timer)
  }

  dispose(): void {
    this.#disposed = true
    this.#subscription.dispose()
    for (const timer of this.#pending.values())
      clearTimeout(timer)
    this.#pending.clear()
    this.#cache.clear()
    this.#changes.dispose()
  }

  async status(conversationId: string, branchId?: string): Promise<LocalConversationStatus> {
    const scope = parse(conversationStatusRequestSchema, { conversationId, branchId })
    const snapshot = this.#snapshot(scope)
    return structuredClone({
      ...snapshot.status,
      cacheWarming: this.#options.getCacheWarmingStatus?.(conversationId) ?? null,
      timing: {
        ...snapshot.status.timing,
        wallMs: snapshot.wallStart === null ? 0 : Math.max(0, (snapshot.wallEnd ?? Date.now()) - snapshot.wallStart),
      },
    })
  }

  metrics(input: TaskMetricsRequest): LocalTaskMetrics {
    const scope = parse(taskMetricsRequestSchema, input)
    const snapshot = this.#snapshot(scope)
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = snapshot.status.tokens.totals
    return {
      ...scope,
      turns: snapshot.status.activity.turns,
      steps: snapshot.steps,
      tokens: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
      throughput: { ...snapshot.status.timing.throughput },
    }
  }

  #snapshot(scope: ConversationStatisticsScope): ConversationStatisticsSnapshot {
    const hasTarget = this.#options.repository.hasTarget(scope)
    if (this.#disposed || (!hasTarget && scope.branchId !== undefined))
      throw new BuddyServiceError('VALIDATION_FAILED')
    const key = JSON.stringify([scope.conversationId, scope.branchId ?? null])
    if (!hasTarget) {
      this.#cache.delete(key)
      return this.#options.repository.read(scope)
    }
    const snapshot = this.#options.repository.read(scope, this.#cache.get(key))
    this.#cache.delete(key)
    this.#cache.set(key, snapshot)
    if (this.#cache.size > CACHE_LIMIT)
      this.#cache.delete(this.#cache.keys().next().value!)
    return snapshot
  }
}
