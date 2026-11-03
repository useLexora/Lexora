import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionScope } from '../../../shared/executions/executionPresentationApi'
import type { AskUserInput, UserQuestionRequest, UserQuestionsChanged, UserQuestionSubmit, UserQuestionTarget } from '../../../shared/questions/userQuestionApi'
import type { ExecutionCoordinator } from '../agent/execution/ExecutionCoordinator'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { ExecutionRepository } from '../storage/executionRepository'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { askUserInputSchema, userQuestionRequestSchema, userQuestionRpc, validateUserQuestionResponse } from '../../../shared/questions/userQuestionApi'
import { executionFence } from '../storage/executionRepository'

interface Options {
  database: DatabaseSync
  executions: Pick<ExecutionRepository, 'find' | 'assertCurrent'>
  conversations: Pick<ConversationRepository, 'findById'>
  coordinator: Pick<ExecutionCoordinator, 'waitForUser'>
  deliver: (request: UserQuestionRequest) => Promise<string | null>
}

export class UserQuestionService {
  readonly #options: Options
  readonly #changes = new Emitter<UserQuestionsChanged>(() => {})
  readonly #waiting = new Map<string, number>()
  readonly #operations = new Map<string, Promise<UserQuestionRequest>>()
  readonly #stopping = new AbortController()
  readonly onDidChange = this.#changes.event

  constructor(options: Options) {
    this.#options = options
    for (const request of this.#all()) {
      const source = options.executions.find(request.runId)
      if (request.status === 'pending' && (request.mode !== 'async' || source?.run.status !== 'completed'))
        this.#save({ ...request, status: 'interrupted', resolvedAt: new Date().toISOString() })
      else if (request.delivery?.state === 'pending')
        this.#save({ ...request, delivery: { state: 'failed', targetRunId: null } })
    }
  }

  list(scope: ExecutionScope): UserQuestionRequest[] {
    return this.#options.database.prepare('SELECT q.request_json, q.tool_call_id FROM user_questions q JOIN runs r ON r.id = q.run_id WHERE r.conversation_id = ? AND r.branch_id = ? ORDER BY r.started_at, q.rowid')
      .all(scope.conversationId, scope.branchId)
      .map(row => this.#decode(row))
  }

  hasPending(runId: string): boolean {
    return !!this.#options.database.prepare('SELECT 1 FROM user_questions WHERE run_id = ? AND json_extract(request_json, \'$.status\') = \'pending\' LIMIT 1').get(runId)
  }

  isWaiting(runId: string): boolean {
    return (this.#waiting.get(runId) ?? 0) > 0
  }

  ask(runId: string, toolCallId: string, input: AskUserInput, signal: AbortSignal): UserQuestionRequest {
    signal.throwIfAborted()
    const parsed = askUserInputSchema.parse(input)
    const run = this.#assertLive(runId)
    const row = this.#options.database.prepare('SELECT request_json, tool_call_id FROM user_questions WHERE run_id = ? AND tool_call_id = ?').get(runId, toolCallId)
    if (row) {
      const previous = this.#decode(row)
      if (JSON.stringify(previous.questions) !== JSON.stringify(parsed.questions))
        throw new Error('QUESTION_CONFLICT')
      return previous
    }
    const request: UserQuestionRequest = {
      ...parsed,
      id: randomUUID(),
      runId,
      toolCallId,
      mode: 'async',
      rootRunId: run.rootRunId,
      conversationId: run.conversationId,
      branchId: run.branchId,
      buddyName: run.actorSnapshot?.name ?? 'Lexora',
      status: 'pending',
      response: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    }
    this.#options.database.prepare('INSERT INTO user_questions (id, run_id, tool_call_id, request_json) VALUES (?, ?, ?, ?)').run(request.id, runId, toolCallId, JSON.stringify(request))
    this.#changes.fire(request)
    return request
  }

  async wait(runId: string, requestId: string, signal: AbortSignal, deliveredMessageIds: readonly string[] = []): Promise<UserQuestionRequest> {
    this.#assertLive(runId)
    const request = this.#find(requestId)
    if (request.runId !== runId)
      throw new Error('QUESTION_NOT_FOUND')
    const waitingSignal = AbortSignal.any([signal, this.#stopping.signal])
    const ready = () => {
      const current = this.#find(requestId)
      return current.status !== 'pending' && (!current.delivery || current.delivery.state === 'delivered') ? current : null
    }
    const resolved = ready()
    if (resolved)
      return resolved
    this.#waiting.set(runId, (this.#waiting.get(runId) ?? 0) + 1)
    this.#changes.fire(request)
    try {
      const resolved = await this.#options.coordinator.waitForUser(runId, async (signal) => {
        const result = Promise.withResolvers<UserQuestionRequest>()
        const abort = () => result.reject(signal.reason)
        const check = () => {
          const current = ready()
          if (current)
            result.resolve(current)
        }
        const subscription = this.onDidChange((event) => {
          if (event.runId === runId)
            check()
        })
        signal.addEventListener('abort', abort, { once: true })
        try {
          if (signal.aborted)
            abort()
          else
            check()
          return await result.promise
        }
        finally {
          subscription.dispose()
          signal.removeEventListener('abort', abort)
        }
      }, waitingSignal, deliveredMessageIds)
      return resolved ?? this.#find(requestId)
    }
    finally {
      const remaining = (this.#waiting.get(runId) ?? 1) - 1
      if (remaining)
        this.#waiting.set(runId, remaining)
      else
        this.#waiting.delete(runId)
      this.#changes.fire(request)
    }
  }

  answer(input: UserQuestionSubmit): Promise<UserQuestionRequest> {
    const parsed = userQuestionRpc.answer.input.parse(input)
    return this.#serialize(parsed.requestId, async () => {
      const request = this.#target(parsed)
      const response = validateUserQuestionResponse(request.questions, { answers: parsed.answers })
      if (request.status === 'answered' && JSON.stringify(response) === JSON.stringify(request.response))
        return request.delivery?.state === 'delivered' ? request : this.#deliver(request)
      if (request.status !== 'pending')
        throw new Error('QUESTION_CLOSED')
      return this.#deliver(this.#save({ ...request, status: 'answered', response, resolvedAt: new Date().toISOString(), delivery: { state: 'pending', targetRunId: null } }))
    })
  }

  cancel(input: UserQuestionTarget): Promise<UserQuestionRequest> {
    return this.#serialize(input.requestId, async () => {
      const request = this.#target(input)
      if (request.status === 'cancelled')
        return request
      if (request.status !== 'pending')
        throw new Error('QUESTION_CLOSED')
      return this.#deliver(this.#save({ ...request, status: 'cancelled', resolvedAt: new Date().toISOString(), delivery: { state: 'pending', targetRunId: null } }))
    })
  }

  retry(input: UserQuestionTarget): Promise<UserQuestionRequest> {
    return this.#serialize(input.requestId, async () => {
      const request = this.#target(input)
      if (!request.delivery || request.status === 'pending' || request.status === 'interrupted')
        throw new Error('QUESTION_CLOSED')
      return request.delivery.state === 'delivered' ? request : this.#deliver(request)
    })
  }

  async executionSettled(runId: string): Promise<void> {
    if (this.#stopping.signal.aborted)
      return
    const run = this.#options.executions.find(runId)?.run
    if (!run)
      return
    for (const request of this.#all().filter(request => request.conversationId === run.conversationId)) {
      if (request.runId === runId && request.status === 'pending' && run.status !== 'completed') {
        this.#save({ ...request, status: run.status === 'cancelled' ? 'cancelled' : 'interrupted', resolvedAt: new Date().toISOString() })
      }
      else if (request.delivery?.state === 'pending') {
        await this.retry({ ...request, requestId: request.id }).catch(() => {})
      }
    }
  }

  async retryPending(scope: ExecutionScope): Promise<void> {
    if (this.#stopping.signal.aborted)
      return
    for (const request of this.list(scope)) {
      if (request.delivery?.state === 'pending')
        await this.retry({ ...scope, requestId: request.id }).catch(() => {})
    }
  }

  #target(input: UserQuestionTarget): UserQuestionRequest {
    const request = this.#find(input.requestId)
    if (request.conversationId !== input.conversationId || request.branchId !== input.branchId)
      throw new Error('QUESTION_NOT_FOUND')
    const conversation = this.#options.conversations.findById(request.conversationId)
    if (!conversation || conversation.deletedAt || conversation.activeBranchId !== request.branchId)
      throw new Error('QUESTION_STALE')
    return request
  }

  #assertLive(runId: string) {
    const record = this.#options.executions.find(runId)
    const root = record && this.#options.executions.find(record.run.rootRunId)
    if (!record || !root || this.#options.conversations.findById(record.run.conversationId)?.activeBranchId !== record.run.branchId)
      throw new Error('QUESTION_STALE')
    this.#options.executions.assertCurrent(executionFence(record, root))
    return record.run
  }

  #find(id: string): UserQuestionRequest {
    const row = this.#options.database.prepare('SELECT request_json, tool_call_id FROM user_questions WHERE id = ?').get(id)
    if (!row)
      throw new Error('QUESTION_NOT_FOUND')
    return this.#decode(row)
  }

  #decode(row: Record<string, unknown>): UserQuestionRequest {
    return userQuestionRequestSchema.parse({ ...JSON.parse(String(row.request_json)), toolCallId: String(row.tool_call_id) })
  }

  #all(): UserQuestionRequest[] {
    return this.#options.database.prepare('SELECT request_json, tool_call_id FROM user_questions ORDER BY rowid').all().map(row => this.#decode(row))
  }

  #save(request: UserQuestionRequest): UserQuestionRequest {
    this.#options.database.prepare('UPDATE user_questions SET request_json = ? WHERE id = ?').run(JSON.stringify(request), request.id)
    this.#changes.fire(request)
    return request
  }

  async #deliver(request: UserQuestionRequest): Promise<UserQuestionRequest> {
    if (this.#stopping.signal.aborted)
      return request
    const pending = this.#save({ ...request, delivery: { state: 'pending', targetRunId: null } })
    try {
      const targetRunId = await this.#options.deliver(pending)
      return targetRunId ? this.#save({ ...pending, delivery: { state: 'delivered', targetRunId } }) : pending
    }
    catch {
      return this.#save({ ...pending, delivery: { state: 'failed', targetRunId: null } })
    }
  }

  #serialize(id: string, operation: () => Promise<UserQuestionRequest>): Promise<UserQuestionRequest> {
    const result = (this.#operations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.#operations.set(id, result)
    void result.finally(() => {
      if (this.#operations.get(id) === result)
        this.#operations.delete(id)
    }).catch(() => {})
    return result
  }

  async dispose() {
    this.#stopping.abort()
    await Promise.allSettled([...this.#operations.values()])
    this.#changes.dispose()
  }
}
