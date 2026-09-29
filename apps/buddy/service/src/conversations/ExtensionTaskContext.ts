import type { ExtensionActionCause } from '../../../shared/extensions/extensionAgent'
import type { ExtensionInvocationScope } from '../plugins/extensionAgentHandlers'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { ExtensionTaskContextRepository } from '../storage/extensionTaskContextRepository'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRepository } from '../storage/runRepository'

export interface ExtensionTaskSession {
  conversationId: string
  branchId: string
  model: { providerId: string, modelId: string } | null
  assertCurrent: () => void
}

export class ExtensionTaskContext {
  readonly tasks: Pick<ConversationRepository, 'findById'>
  readonly history: ExtensionTaskContextRepository
  readonly runs: Pick<RunRepository, 'findById'>
  readonly inputs: Pick<RunInputRepository, 'findByMessageId'>

  constructor(
    tasks: Pick<ConversationRepository, 'findById'>,
    history: ExtensionTaskContextRepository,
    runs: Pick<RunRepository, 'findById'>,
    inputs: Pick<RunInputRepository, 'findByMessageId'>,
  ) {
    this.tasks = tasks
    this.history = history
    this.runs = runs
    this.inputs = inputs
  }

  valid(conversationId: string, cause: ExtensionActionCause): boolean {
    const task = this.tasks.findById(conversationId)
    if (!task || task.deletedAt !== null || !task.activeBranchId)
      return false
    if (cause.type === 'user')
      return true
    if (cause.data.conversationId !== conversationId || task.activeBranchId !== cause.data.branchId)
      return false
    const inputId = this.history.latestInput(conversationId, task.activeBranchId)
    return cause.type === 'task:input:committed'
      ? inputId === cause.data.messageId
      : inputId === cause.data.triggeringMessageId || (!!inputId && this.inputs.findByMessageId(inputId)?.runId === cause.data.runId)
  }

  open(scope: ExtensionInvocationScope): ExtensionTaskSession {
    scope.signal.throwIfAborted()
    const conversationId = scope.conversationId
    const task = this.tasks.findById(conversationId)
    if (!task || task.deletedAt !== null || !task.activeBranchId || (scope.action && !this.valid(conversationId, scope.action.cause)))
      throw new Error('EXTENSION_TASK_UNAVAILABLE')
    const branchId = task.activeBranchId
    const inputMessageId = this.history.latestInput(conversationId, branchId)
    const runId = scope.runId ?? (scope.action && scope.action.cause.type !== 'user' ? scope.action.cause.data.runId : inputMessageId ? this.inputs.findByMessageId(inputMessageId)?.runId : null)
    const run = runId ? this.runs.findById(runId) : null
    const runModel = run ? { providerId: run.provider, modelId: run.model } : null
    const model = scope.action ? task.modelSelection ?? runModel : runModel
    if (!scope.action && (!run || run.status !== 'running' || run.conversationId !== conversationId || run.branchId !== branchId))
      throw new Error('EXTENSION_TASK_UNAVAILABLE')
    const assertCurrent = () => {
      scope.signal.throwIfAborted()
      const current = this.tasks.findById(conversationId)
      if (!current || current.deletedAt !== null || current.activeBranchId !== branchId || this.history.latestInput(conversationId, branchId) !== inputMessageId || (!scope.action && this.runs.findById(scope.runId!)?.status !== 'running'))
        throw new Error('EXTENSION_TASK_UNAVAILABLE')
    }
    return { conversationId, branchId, model: model ? { providerId: model.providerId, modelId: model.modelId } : null, assertCurrent }
  }

  captureAction(conversationId: string, cause: ExtensionActionCause) {
    if (!this.valid(conversationId, cause))
      return null
    const branchId = this.tasks.findById(conversationId)!.activeBranchId!
    return { branchId, sourceMessageId: this.history.latestInput(conversationId, branchId) }
  }
}
