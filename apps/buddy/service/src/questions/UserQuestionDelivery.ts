import type { DatabaseSync } from 'node:sqlite'
import type { UserQuestionRequest } from '../../../shared/questions/userQuestionApi'
import type { BuddyAgentRunner } from '../agent/execution/BuddyAgentRunner'
import type { ExecutionCoordinator } from '../agent/execution/ExecutionCoordinator'
import type { ChatTurnService } from '../chat/ChatTurnService'
import type { ExecutionRepository } from '../storage/executionRepository'
import type { MailboxRepository } from '../storage/mailboxRepository'
import { renderUserQuestionReply } from '../../../shared/questions/userQuestionReply'
import { ExecutionAdmissionError } from '../storage/executionRepository'

interface Options {
  database: DatabaseSync
  executions: Pick<ExecutionRepository, 'find'>
  mailbox: Pick<MailboxRepository, 'find'>
  coordinator: Pick<ExecutionCoordinator, 'send'>
  runner: Pick<BuddyAgentRunner, 'hasActiveExecution' | 'isStopping'>
  turns: Pick<ChatTurnService, 'continueQuestion'>
}

export class UserQuestionDelivery {
  readonly #options: Options
  readonly #operations = new Map<string, Promise<string | null>>()

  constructor(options: Options) { this.#options = options }

  deliver(request: UserQuestionRequest): Promise<string | null> {
    const key = request.conversationId
    const pending = (this.#operations.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.#deliver(request))
    this.#operations.set(key, pending)
    void pending.finally(() => {
      if (this.#operations.get(key) === pending)
        this.#operations.delete(key)
    }).catch(() => {})
    return pending
  }

  async #deliver(request: UserQuestionRequest): Promise<string | null> {
    const messageId = `user-question:${request.id}`
    const receipt = this.#options.mailbox.find(messageId)
    if (receipt)
      return receipt.message.targetRunId
    let owner = this.#options.executions.find(request.runId)
    if (!owner)
      throw new Error('QUESTION_STALE')
    if (request.status === 'cancelled' && owner.phase === 'closed')
      return owner.run.id
    if (owner.cancelRequestedAt || ['failed', 'cancelled'].includes(owner.run.status))
      throw new Error('QUESTION_STALE')
    if (owner.phase === 'closing')
      return null
    if (owner.phase === 'closed' && owner.run.executionKind === 'npc_child') {
      while (owner?.run.executionKind === 'npc_child' && owner.run.parentRunId)
        owner = this.#options.executions.find(owner.run.parentRunId)
    }
    if (!owner || owner.cleanupState === 'degraded' || owner.cancelRequestedAt)
      throw new Error('QUESTION_STALE')
    if (owner.phase === 'closing')
      return null
    if (owner.phase !== 'closed') {
      try {
        await this.#options.coordinator.send(owner.run.id, {
          kind: 'supplement',
          origin: 'user',
          purpose: 'question_answer',
          messageId,
          targetRunId: owner.run.id,
          targetGeneration: owner.run.generation,
          text: renderUserQuestionReply(request),
        })
        return owner.run.id
      }
      catch (error) {
        if (error instanceof ExecutionAdmissionError && error.code === 'stale') {
          const current = this.#options.executions.find(owner.run.id)
          if (current?.phase === 'closing' || current?.phase === 'closed')
            return current.phase === 'closing' ? null : this.#deliver(request)
        }
        throw error
      }
    }
    if (owner.run.status !== 'completed' || this.#options.runner.isStopping)
      throw new Error('QUESTION_STALE')
    if (this.#options.runner.hasActiveExecution(owner.run.conversationId, owner.run.buddyId)
      || this.#options.database.prepare(`SELECT 1 FROM runs WHERE conversation_id = ? AND buddy_id = ? AND status IN ('queued', 'running') LIMIT 1`).get(owner.run.conversationId, owner.run.buddyId)
      || this.#options.database.prepare(`SELECT 1 FROM chat_queue WHERE conversation_id = ? AND branch_id = ? AND state IN ('waiting', 'paused') LIMIT 1`).get(request.conversationId, request.branchId)) {
      return null
    }
    return this.#options.turns.continueQuestion(request, owner.run)
  }
}
