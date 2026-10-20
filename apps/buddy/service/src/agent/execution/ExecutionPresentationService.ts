import type { ExecutionAnswer, ExecutionEventsRequest, ExecutionsChanged, ExecutionScope, ExecutionSend, ExecutionTarget, LocalExecution, LocalExecutionDetail, LocalExecutionEventsPage } from '../../../../shared/executions/executionPresentationApi'
import type { BuddiesService } from '../../buddies/BuddiesService'
import type { ChangeCaptureService } from '../../changes/ChangeCaptureService'
import type { MutationCoordinator } from '../../changes/MutationCoordinator'
import type { BuddyRunEvent } from '../../events/BuddyRunEvent'
import type { RunEventAvailability, RunEventObservation, RunEventReader } from '../../events/RunEventPorts'
import type { ApprovalRepository } from '../../storage/approvalRepository'
import type { ArtifactRepository } from '../../storage/artifactRepository'
import type { ConversationRepository } from '../../storage/conversationRepository'
import type { ExecutionRepository, ExecutionStateRecord } from '../../storage/executionRepository'
import type { MailboxRepository } from '../../storage/mailboxRepository'
import type { RunRepository } from '../../storage/runRepository'
import type { UsageRepository } from '../../storage/usageRepository'
import type { ExecutionCoordinator } from './ExecutionCoordinator'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../../shared/events/Emitter'
import { executionAnswerSchema, executionEventsRequestSchema, executionScopeSchema, executionSendSchema, executionTargetSchema } from '../../../../shared/executions/executionPresentationApi'
import { toPublicRunEvent } from '../../../../shared/runs/publicRunEvent'
import { buddyRunProgressSchema } from '../../../../shared/runs/runProgress'
import { projectRunOutputs } from '../../conversations/projectRunOutputs'
import { BuddyServiceError, parse } from '../../rpc/runtimeRequest'
import { toPublicRun } from '../../runs/publicRun'
import { readExecutionResult } from './readExecutionResult'

export interface ExecutionPresentationOptions {
  approvals: Pick<ApprovalRepository, 'hasPending'>
  conversations: Pick<ConversationRepository, 'findById' | 'listBranches' | 'listBranchMessages'>
  runs: Pick<RunRepository, 'listForTimeline'>
  executions: Pick<ExecutionRepository, 'find' | 'listTree'>
  mailbox: Pick<MailboxRepository, 'find' | 'findQuestion' | 'listQuestions'>
  buddies: Pick<BuddiesService, 'get'>
  coordinator: Pick<ExecutionCoordinator, 'onDidChange' | 'answerQuestion' | 'send' | 'cancel'>
  mutations: Pick<MutationCoordinator, 'onDidChange' | 'getRunState'>
  events: Pick<RunEventReader, 'read' | 'list' | 'listForRuns' | 'listToolCounts'> & Pick<RunEventObservation, 'onDidCommit'> & Partial<Pick<RunEventAvailability, 'getRecoveryFailures'>>
  artifacts: Pick<ArtifactRepository, 'listForConversation'>
  changes: Pick<ChangeCaptureService, 'listSummariesForRuns'>
  usage: Pick<UsageRepository, 'listForRun'>
  stopExecution: (runId: string) => Promise<boolean>
  onObserverError?: (error: unknown) => void
}

export class ExecutionPresentationService {
  readonly #options: ExecutionPresentationOptions
  readonly #sourceId = randomUUID()
  readonly #changes: Emitter<ExecutionsChanged>
  readonly #subscriptions: Array<{ dispose: () => void }>
  readonly onDidChange: Emitter<ExecutionsChanged>['event']
  #revision = 0
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: ExecutionPresentationOptions) {
    this.#options = options
    this.#changes = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidChange = this.#changes.event
    this.#subscriptions = [
      options.events.onDidCommit((event) => {
        const record = options.executions.find(event.runId)
        if (!record || this.#pending.has(record.run.rootRunId))
          return
        const rootId = record.run.rootRunId
        this.#pending.set(rootId, setTimeout(() => {
          this.#pending.delete(rootId)
          this.#publish(rootId)
        }, 120))
      }),
      options.coordinator.onDidChange(change => this.#publish(change.rootRunId)),
      options.mutations.onDidChange(change => this.#publish(options.executions.find(change.runId)?.run.rootRunId)),
    ]
  }

  list(input: ExecutionScope): LocalExecution[] {
    const scope = parse(executionScopeSchema, input)
    return this.#visibleRoots(scope).flatMap((rootId) => {
      const tree = this.#options.executions.listTree(rootId)
      const events = this.#options.events.listForRuns(tree.map(record => record.run.id), { latestActivityOnly: true })
      const tools = this.#options.events.listToolCounts(tree.map(record => record.run.id))
      return tree.map(record => this.#present(scope, record, tree, events.filter(event => event.runId === record.run.id), tools.get(record.run.id) ?? 0))
    })
  }

  async detail(input: ExecutionTarget): Promise<LocalExecutionDetail> {
    const target = parse(executionTargetSchema, input)
    this.#requireTarget(target)
    const result = await readExecutionResult(this.#options.events, target.runId)
    const record = this.#requireTarget(target)
    const tree = this.#options.executions.listTree(target.rootRunId)
    const events = this.#options.events.listForRuns([target.runId])
    const artifacts = projectRunOutputs(events, this.#options.artifacts.listForConversation(target.conversationId))
      .flatMap(output => output.artifacts)
    const caller = tree.find(member => member.run.id === record.run.parentRunId)
    const usage = this.#options.usage.listForRun(target.runId).filter(record => record.purpose !== 'cache_warm')
    return {
      execution: this.#present(target, record, tree, events, this.#options.events.listToolCounts([target.runId]).get(target.runId) ?? 0),
      run: toPublicRun(record.run, record.initialInput?.reasoning ?? null),
      caller: caller ? { runId: caller.run.id, buddyName: this.#options.buddies.get(caller.run.buddyId).name, ordinal: executionOrdinal(caller, tree) } : null,
      inputs: events.flatMap((event) => {
        if (event.type !== 'execution.mailbox.sent')
          return []
        const message = this.#options.mailbox.find((event.payload as { messageId: string }).messageId)
        if (!message || message.message.targetRunId !== target.runId)
          return []
        const value = message.message
        const question = value.kind === 'answer' ? this.#options.mailbox.findQuestion(value.questionId) : null
        const questionMessage = question && question.message.kind === 'question' ? question.message : null
        const userInput = (value.kind === 'supplement' && value.origin === 'user')
          || (value.kind === 'answer' && value.sourceRunId === target.runId && questionMessage?.audience === 'user')
        if (!userInput || (value.kind !== 'supplement' && value.kind !== 'answer'))
          return []
        return [{ kind: value.kind, messageId: value.messageId, text: value.text, createdAt: event.createdAt, state: message.state }]
      }),
      result: result || null,
      artifacts: [...new Map(artifacts.map(artifact => [artifact.artifactId, artifact])).values()],
      changes: this.#options.changes.listSummariesForRuns([target.runId])[0] ?? null,
      usage: usage.length
        ? usage.reduce((total, record) => ({
            inputTokens: total.inputTokens + record.inputTokens,
            outputTokens: total.outputTokens + record.outputTokens,
            cacheReadTokens: total.cacheReadTokens + record.cacheReadTokens,
            cacheWriteTokens: total.cacheWriteTokens + record.cacheWriteTokens,
          }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
        : null,
    }
  }

  async events(input: ExecutionEventsRequest): Promise<LocalExecutionEventsPage> {
    const target = parse(executionEventsRequestSchema, input)
    this.#requireTarget(target)
    const events = await this.#options.events.list(target.runId, { afterSequence: target.afterSequence, limit: 501 })
    this.#requireTarget(target)
    const page = events.slice(0, 500)
    return { events: page.map(toPublicRunEvent), nextSequence: page.at(-1)?.sequence ?? target.afterSequence, hasMore: events.length > page.length }
  }

  async send(input: ExecutionSend): Promise<{ accepted: boolean }> {
    const target = parse(executionSendSchema, input)
    const record = this.#requireTarget(target)
    if (record.run.executionKind === 'root' || record.run.executionKind === 'maintenance')
      throw new BuddyServiceError('VALIDATION_FAILED')
    const previous = this.#options.mailbox.find(target.messageId)
    if (previous === null)
      this.#requireLiveTarget(target)
    await this.#options.coordinator.send(target.runId, { kind: 'supplement', origin: 'user', messageId: target.messageId, text: target.text, targetRunId: target.runId, targetGeneration: previous?.message.targetGeneration ?? record.run.generation })
    return { accepted: true }
  }

  async cancelChildren(input: ExecutionTarget): Promise<{ cancelledRunIds: string[] }> {
    const target = parse(executionTargetSchema, input)
    this.#requireCancellableTarget(target)
    const children = this.#options.executions.listTree(target.rootRunId).filter(record => record.run.parentRunId === target.runId && isCancellable(record))
    const results = await Promise.all(children.map(async record => await this.#options.coordinator.cancel(record.run.id, 'RUN_CANCELLED', this.#options.stopExecution) ? [record.run.id] : []))
    return { cancelledRunIds: results.flat() }
  }

  async answer(input: ExecutionAnswer): Promise<{ accepted: boolean }> {
    const target = parse(executionAnswerSchema, input)
    this.#requireTarget(target)
    const question = this.#options.mailbox.findQuestion(target.questionId)
    if (!question || question.message.kind !== 'question' || question.message.audience !== 'user' || question.message.sourceRunId !== target.runId)
      throw new BuddyServiceError('VALIDATION_FAILED')
    if (!question.answer)
      this.#requireLiveTarget(target)
    await this.#options.coordinator.answerQuestion(null, target.questionId, target.text, target.messageId)
    return { accepted: true }
  }

  async cancel(input: ExecutionTarget): Promise<{ cancelled: boolean }> {
    const target = parse(executionTargetSchema, input)
    this.#requireCancellableTarget(target)
    return { cancelled: await this.#options.coordinator.cancel(target.runId, 'RUN_CANCELLED', this.#options.stopExecution) }
  }

  dispose() {
    for (const timer of this.#pending.values())
      clearTimeout(timer)
    this.#pending.clear()
    for (const subscription of this.#subscriptions)
      subscription.dispose()
    this.#changes.dispose()
  }

  #visibleRoots(scope: ExecutionScope): string[] {
    const conversation = this.#options.conversations.findById(scope.conversationId)
    if (!conversation || conversation.deletedAt || !this.#options.conversations.listBranches(scope.conversationId).some(branch => branch.id === scope.branchId))
      throw new BuddyServiceError('VALIDATION_FAILED')
    const messages = this.#options.conversations.listBranchMessages(scope.conversationId, scope.branchId)
    return this.#options.runs.listForTimeline(scope.conversationId, scope.branchId, messages.filter(message => message.role === 'user').map(message => message.id), messages.flatMap(message => message.runId ? [message.runId] : []))
      .filter(run => run.executionKind === 'root')
      .map(run => run.id)
  }

  #requireTarget(target: ExecutionTarget): ExecutionStateRecord {
    if (!this.#visibleRoots(target).includes(target.rootRunId))
      throw new BuddyServiceError('VALIDATION_FAILED')
    const record = this.#options.executions.find(target.runId)
    if (!record || record.run.rootRunId !== target.rootRunId || record.run.conversationId !== target.conversationId)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return record
  }

  #requireCancellableTarget(target: ExecutionTarget): ExecutionStateRecord {
    const record = this.#requireTarget(target)
    const root = this.#options.executions.find(target.rootRunId)
    if (!root || root.phase === 'closed' || !isCancellable(record)
      || record.run.branchId !== target.branchId
      || this.#options.conversations.findById(target.conversationId)?.activeBranchId !== target.branchId) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    return record
  }

  #requireLiveTarget(target: ExecutionTarget): ExecutionStateRecord {
    const record = this.#requireTarget(target)
    const root = this.#options.executions.find(target.rootRunId)
    if (!root || !isLive(record) || !isLive(root)
      || record.run.branchId !== target.branchId
      || this.#options.conversations.findById(target.conversationId)?.activeBranchId !== target.branchId) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    return record
  }

  #present(scope: ExecutionScope, record: ExecutionStateRecord, tree: readonly ExecutionStateRecord[], events: readonly BuddyRunEvent[], toolCount: number): LocalExecution {
    const { run } = record
    const quarantined = this.#options.events.getRecoveryFailures?.().some(failure => failure.runId === run.id
      || (run.id === run.rootRunId && tree.some(child => child.run.id === failure.runId))) ?? false
    const progressEvent = events.findLast(event => event.type === 'run.progress')
    const parsedProgress = buddyRunProgressSchema.safeParse(progressEvent?.payload)
    const progress = parsedProgress.success ? parsedProgress.data : null
    const mutations = this.#options.mutations.getRunState(run.id)
    const questions = this.#options.mailbox.listQuestions(run.id).flatMap((message) => {
      if (message.kind !== 'question')
        return []
      const question = this.#options.mailbox.findQuestion(message.questionId)
      return [{ questionId: message.questionId, text: message.text, audience: message.audience ?? 'caller', open: question?.open ?? false, answered: question?.answer !== null && question?.answer !== undefined }]
    })
    const activeChildren = tree.filter(child => child.run.parentRunId === run.id && child.phase !== 'closed').length
    const mutable = isLive(record) && isLive(tree.find(member => member.run.id === run.rootRunId) ?? record)
      && run.branchId === scope.branchId && this.#options.conversations.findById(scope.conversationId)?.activeBranchId === scope.branchId
    const affectedResources = mutations.hazards.flatMap(hazard => hazard.claims.map(claim => claim.kind === 'host'
      ? { kind: 'host' as const }
      : { kind: 'path' as const, path: claim.canonicalPath }))
    return {
      runId: run.id,
      rootRunId: run.rootRunId,
      parentRunId: run.parentRunId,
      buddyId: run.buddyId,
      buddyName: this.#options.buddies.get(run.buddyId).name,
      ordinal: executionOrdinal(record, tree),
      kind: run.executionKind,
      phase: record.phase,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      updatedAt: events.at(-1)?.createdAt ?? run.startedAt,
      progress,
      toolCount,
      stopping: record.cancelRequestedAt !== null && record.phase !== 'closed',
      task: record.initialInput?.prompt.slice(0, 300) ?? '',
      waitingFor: questions.some(question => question.open) ? 'answer' : isLive(record) && this.#options.approvals.hasPending(run.id) ? 'approval' : mutations.pending ? 'resource' : record.phase === 'waiting' && activeChildren ? 'children' : null,
      activeChildren,
      canCancel: isCancellable(record) && tree.find(member => member.run.id === run.rootRunId)?.phase !== 'closed'
        && run.branchId === scope.branchId && this.#options.conversations.findById(scope.conversationId)?.activeBranchId === scope.branchId,
      canSend: mutable && (run.executionKind === 'actor_child' || run.executionKind === 'npc_child'),
      canAnswer: mutable && questions.some(question => question.open && question.audience === 'user'),
      cleanup: quarantined || mutations.hazards.length ? 'degraded' : record.cleanupState,
      errorCode: quarantined ? 'EVENT_LOG_CORRUPTED' : record.cleanupErrorCode ?? run.errorCode,
      affectedResources: [...new Map(affectedResources.map(resource => [resource.kind === 'host' ? 'host' : resource.path, resource])).values()],
      questions,
    }
  }

  #publish(rootRunId: string | undefined) {
    if (!rootRunId)
      return
    const record = this.#options.executions.find(rootRunId)
    if (record && this.#options.conversations.findById(record.run.conversationId)?.deletedAt === null)
      this.#changes.fire({ sourceId: this.#sourceId, revision: ++this.#revision, conversationId: record.run.conversationId, rootRunId })
  }
}

function isLive(record: ExecutionStateRecord): boolean {
  return (record.run.status === 'queued' || record.run.status === 'running') && !record.cancelRequestedAt && record.phase !== 'closing' && record.phase !== 'closed'
}

function isCancellable(record: ExecutionStateRecord): boolean {
  return (record.run.status === 'queued' || record.run.status === 'running') && !record.cancelRequestedAt && record.phase !== 'closed'
}

function executionOrdinal(record: ExecutionStateRecord, tree: readonly ExecutionStateRecord[]): number | null {
  if (record.run.executionKind !== 'npc_child' && record.run.executionKind !== 'actor_child')
    return null
  return tree.filter(member => member.run.executionKind === 'npc_child' || member.run.executionKind === 'actor_child').findIndex(member => member.run.id === record.run.id) + 1
}
