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
  readonly assertWritable?: (conversationId: string) => void

  constructor(
    tasks: Pick<ConversationRepository, 'findById'>,
    history: ExtensionTaskContextRepository,
    runs: Pick<RunRepository, 'findById'>,
    inputs: Pick<RunInputRepository, 'findByMessageId'>,
    assertWritable?: (conversationId: string) => void,
  ) {
    this.tasks = tasks
    this.history = history
    this.runs = runs
    this.inputs = inputs
    this.assertWritable = assertWritable
  }

  valid(conversationId: string, cause: ExtensionActionCause): boolean {
    try {
      this.assertWritable?.(conversationId)
    }
    catch {
      return false
    }
    const task = this.tasks.findById(conversationId)
    if (!task || task.deletedAt !== null || task.archivedAt || !task.activeBranchId)
      return false
    if (cause.type === 'user')
      return true
    if (cause.data.conversationId !== conversationId)
      return false
    const inputId = this.history.latestInput(conversationId, cause.data.branchId)
    return cause.type === 'task:turn:completed'
      ? inputId === cause.data.triggeringMessageId || (!!inputId && this.inputs.findByMessageId(inputId)?.runId === cause.data.runId)
      : inputId === cause.data.messageId
  }

  open(scope: ExtensionInvocationScope): ExtensionTaskSession {
    scope.signal.throwIfAborted()
    const conversationId = scope.conversationId
    const task = this.tasks.findById(conversationId)
    if (!task || task.deletedAt !== null || task.archivedAt || !task.activeBranchId || (scope.action && !this.valid(conversationId, scope.action.cause)))
      throw new Error('EXTENSION_TASK_UNAVAILABLE')
    const branchId = scope.runId ? this.runs.findById(scope.runId)?.branchId : scope.action?.cause.type !== 'user' && scope.action ? scope.action.cause.data.branchId : task.activeBranchId
    if (!branchId)
      throw new Error('EXTENSION_TASK_UNAVAILABLE')
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
      if (!current || current.deletedAt !== null || current.archivedAt || this.history.latestInput(conversationId, branchId) !== inputMessageId || (!scope.action && this.runs.findById(scope.runId!)?.status !== 'running'))
        throw new Error('EXTENSION_TASK_UNAVAILABLE')
    }
    return { conversationId, branchId, model: model ? { providerId: model.providerId, modelId: model.modelId } : null, assertCurrent }
  }

  captureAction(conversationId: string, cause: ExtensionActionCause) {
    if (!this.valid(conversationId, cause))
      return null
    const branchId = cause.type === 'user' ? this.tasks.findById(conversationId)!.activeBranchId! : cause.data.branchId
    return { branchId, sourceMessageId: this.history.latestInput(conversationId, branchId) }
  }
}
