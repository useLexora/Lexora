import type { ExecutionSendDraft } from '../../../../shared/executions/executionPresentationApi'
import type { ComposerDraftService } from '../../chat/ComposerDraftService'
import type { ConversationRepository } from '../../storage/conversationRepository'
import type { ExecutionRepository, ExecutionStateRecord } from '../../storage/executionRepository'
import type { MailboxRepository } from '../../storage/mailboxRepository'
import type { ExecutionPresentationService } from './ExecutionPresentationService'
import { createHash } from 'node:crypto'
import { buddyUserContentToText, createBuddyUserContent, getBuddyUserContentActorReferences } from '../../../../shared/conversation/buddyUserContent'
import { isExecutionTextInput } from '../../../../shared/executions/executionComposerInput'
import { BuddyServiceError } from '../../rpc/runtimeRequest'
import { ExecutionAdmissionError } from '../../storage/executionRepository'

interface ExecutionComposerInputOptions {
  drafts: Pick<ComposerDraftService, 'update'>
  conversations: Pick<ConversationRepository, 'findById'>
  executions: Pick<ExecutionRepository, 'find'>
  mailbox: Pick<MailboxRepository, 'find' | 'findQuestion' | 'listQuestions'>
  delivery: Pick<ExecutionPresentationService, 'send' | 'answer'>
}

export class ExecutionComposerInputService {
  readonly #options: ExecutionComposerInputOptions

  constructor(options: ExecutionComposerInputOptions) {
    this.#options = options
  }

  async send(input: ExecutionSendDraft) {
    const digest = createHash('sha256').update(JSON.stringify(['composer-execution-input', input.draftId, input.expectedRevision, input.conversationId, input.branchId, input.rootRunId, input.runId])).digest('hex')
    const messageId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
    let accepted = false
    const draft = await this.#options.drafts.update(input.draftId, async (draft) => {
      const execution = this.#options.executions.find(input.runId)
      if (!execution || !['actor_child', 'root'].includes(execution.run.executionKind))
        throw new BuddyServiceError('VALIDATION_FAILED')
      const previous = this.#options.mailbox.find(messageId)
      if (!previous) {
        if (draft.revision !== input.expectedRevision)
          throw new BuddyServiceError('DRAFT_CONFLICT')
        const actors = [...new Set(getBuddyUserContentActorReferences(draft.content).map(reference => reference.actorId))]
        if (draft.scope.kind !== 'conversation_branch' || draft.scope.conversationId !== input.conversationId || draft.scope.branchId !== input.branchId
          || actors.length !== 1 || actors[0] !== execution.run.buddyId || !isExecutionTextInput(draft.content)
          || execution.run.rootRunId !== input.rootRunId || execution.run.conversationId !== input.conversationId || execution.run.branchId !== input.branchId
          || this.#options.conversations.findById(input.conversationId)?.activeBranchId !== input.branchId) {
          throw new BuddyServiceError('VALIDATION_FAILED')
        }
      }
      if (!previous && this.#unavailable(execution))
        return null
      const question = this.#options.mailbox.listQuestions(input.runId)
        .find(question => question.kind === 'question' && question.audience === 'user' && this.#options.mailbox.findQuestion(question.questionId)?.open)
      const questionId = previous?.message.kind === 'answer' ? previous.message.questionId : question?.kind === 'question' ? question.questionId : null
      if (!previous && execution.run.executionKind === 'root' && !questionId)
        return null
      const delivery = {
        conversationId: input.conversationId,
        branchId: input.branchId,
        rootRunId: input.rootRunId,
        runId: input.runId,
        messageId,
        text: previous?.message.text ?? buddyUserContentToText(draft.content).trim(),
      }
      try {
        if (questionId && previous?.message.kind !== 'supplement')
          await this.#options.delivery.answer({ ...delivery, questionId })
        else
          await this.#options.delivery.send(delivery)
      }
      catch (error) {
        const recorded = this.#options.mailbox.find(messageId)
        const current = this.#options.executions.find(input.runId)
        if (((error instanceof ExecutionAdmissionError && error.code === 'stale') || (error instanceof BuddyServiceError && error.code === 'VALIDATION_FAILED')) && recorded === null && current && this.#unavailable(current))
          return null
        throw error
      }
      accepted = true
      if (draft.revision !== input.expectedRevision)
        return null
      return {
        draftId: draft.draftId,
        expectedRevision: draft.revision,
        content: createBuddyUserContent(),
        executionConfig: draft.executionConfig,
        participants: draft.participants,
        modelSelection: execution.run.buddyId === this.#options.conversations.findById(input.conversationId)?.buddyId ? draft.modelSelection : null,
      }
    })
    return accepted ? draft : null
  }

  #unavailable(execution: ExecutionStateRecord): boolean {
    const root = this.#options.executions.find(execution.run.rootRunId)
    return [execution, root].some(record => !record || record.phase === 'closed' || record.phase === 'closing' || record.cancelRequestedAt !== null)
  }
}
