import type { DatabaseSync } from 'node:sqlite'
import type { LocalChatQueueTarget } from '../../../shared/conversation/chatQueueApi'
import type { CommandRejection } from './CommandCommitter'
import { CommandAdmissionError } from '../commands/CommandAdmissionError'
import { createChatQueueRepository } from './chatQueueRepository'
import { createExecutionRepository } from './executionRepository'
import { ExecutionResourceQueries } from './ExecutionResourceQueries'
import { requireSqliteAuthority } from './sqliteAuthority'
import { withTransaction } from './transaction'

export interface QueueCommandTarget extends LocalChatQueueTarget {
  expectedRevision: number
}

export interface RunCommandTarget {
  runId: string
  expectedRunGeneration: number
}

export class ChatControlConflictError extends Error {
  readonly code: CommandRejection['errorCode']

  constructor(code: CommandRejection['errorCode']) {
    super(code)
    this.code = code
    this.name = 'ChatControlConflictError'
  }
}

export class ChatControlCommandRepository {
  readonly #database: DatabaseSync
  readonly #sourceInstanceId: string
  readonly #queue: ReturnType<typeof createChatQueueRepository>
  readonly #executions: ReturnType<typeof createExecutionRepository>

  constructor(database: DatabaseSync, sourceInstanceId: string) {
    requireSqliteAuthority(database)
    this.#database = database
    this.#sourceInstanceId = sourceInstanceId
    this.#queue = createChatQueueRepository(database)
    this.#executions = createExecutionRepository(database)
  }

  assertAccepting(): void {
    if (this.#database.prepare('SELECT 1 FROM service_admission_gates WHERE source_instance_id = ?').get(this.#sourceInstanceId))
      throw new CommandAdmissionError('SERVICE_STOPPING')
  }

  queueTarget(target: LocalChatQueueTarget): QueueCommandTarget | null {
    const row = this.#database.prepare(`SELECT q.revision FROM chat_queue q JOIN conversations c ON c.id = q.conversation_id
      WHERE q.id = ? AND q.conversation_id = ? AND q.branch_id = ? AND q.state IN ('waiting', 'paused')
        AND c.deleted_at IS NULL`).get(target.id, target.conversationId, target.branchId)
    return row ? { ...target, expectedRevision: Number(row.revision) } : null
  }

  assertQueue(target: QueueCommandTarget): void {
    if (this.queueTarget(target)?.expectedRevision !== target.expectedRevision)
      throw new ChatControlConflictError('QUEUE_CHANGED')
  }

  withQueue<T>(target: QueueCommandTarget, operation: () => T): T {
    return withTransaction(this.#database, () => {
      this.assertAccepting()
      this.assertQueue(target)
      const result = operation()
      if (result && typeof result === 'object' && 'then' in result)
        throw new TypeError('Queue commits must be synchronous')
      return result as T & (T extends PromiseLike<unknown> ? never : unknown)
    })
  }

  cancelQueue(target: QueueCommandTarget): void {
    this.withQueue(target, () => {
      if (!this.#queue.cancel(target))
        throw new ChatControlConflictError('QUEUE_CHANGED')
    })
  }

  assertRun(target: RunCommandTarget, executable = false) {
    const current = this.#executions.find(target.runId)
    if (!current || current.run.generation !== target.expectedRunGeneration)
      throw new ChatControlConflictError('SOURCE_CHANGED')
    if (executable && (current.cancelRequestedAt || !['working', 'waiting'].includes(current.phase)
      || current.run.status !== 'running')) {
      throw new ChatControlConflictError('INPUT_DELIVERY_TARGET_UNAVAILABLE')
    }
    return current
  }

  cancelRun(target: RunCommandTarget) {
    return withTransaction(this.#database, () => {
      this.assertAccepting()
      const current = this.assertRun(target)
      const requested = current.phase !== 'closed'
      if (requested)
        this.#executions.requestCancel(target.runId, new Date().toISOString())
      return {
        target: { runId: target.runId, runGeneration: target.expectedRunGeneration, conversationId: current.run.conversationId, branchId: current.run.branchId },
        result: { cancelRequested: requested, executionResources: new ExecutionResourceQueries(this.#database).subtree(target.runId) },
      }
    })
  }

  stopService(input: { targetServiceInstanceId: string, scope: 'stop_service' | 'keep_service' }, commandId: string) {
    return withTransaction(this.#database, () => {
      if (input.targetServiceInstanceId !== this.#sourceInstanceId)
        throw new CommandAdmissionError('SERVICE_INSTANCE_CHANGED')
      const runIds: string[] = []
      if (input.scope === 'stop_service') {
        const now = new Date().toISOString()
        this.#database.prepare('INSERT INTO service_admission_gates (source_instance_id, stopped_at, command_id) VALUES (?, ?, ?)').run(this.#sourceInstanceId, now, commandId)
        const roots = this.#database.prepare('SELECT r.id FROM runs r JOIN execution_state e ON e.run_id = r.id WHERE r.parent_run_id IS NULL AND e.phase <> \'closed\'').all()
        for (const root of roots) {
          this.#executions.requestCancel(String(root.id), now)
          runIds.push(String(root.id))
        }
        this.#queue.pause()
      }
      return { target: { serviceInstanceId: this.#sourceInstanceId }, result: { scope: input.scope, runIds, executionResources: new ExecutionResourceQueries(this.#database).service() } }
    })
  }

  recordDelivery(queueId: string, runId: string): void {
    this.#database.prepare('INSERT INTO chat_queue_deliveries (queue_id, run_id, stage, committed_at) VALUES (?, ?, \'committed\', ?)').run(queueId, runId, new Date().toISOString())
  }

  observeDelivery(queueId: string, stage: 'submitted' | 'unavailable' | 'unknown'): void {
    withTransaction(this.#database, () => {
      this.#database.prepare('UPDATE chat_queue_deliveries SET stage = ?, observed_at = ? WHERE queue_id = ? AND stage = \'committed\'').run(stage, new Date().toISOString(), queueId)
    })
  }
}
