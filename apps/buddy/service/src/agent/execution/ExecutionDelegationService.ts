import type { BuddyToolOption } from '../../../../shared/buddies/buddyApi'
import type { BuddyPermissionSettings } from '../../../../shared/permissions/permissionMode'
import type { BuddiesService } from '../../buddies/BuddiesService'
import type { BuddyDefinitionResolver } from '../../buddies/BuddyDefinitionResolver'
import type { ConversationMemberRepository } from '../../storage/conversationMemberRepository'
import type { AdmitChildExecutionInput, ExecutionRepository, ExecutionStateRecord } from '../../storage/executionRepository'
import type { MailboxRepository } from '../../storage/mailboxRepository'
import type { BuddyExtensionRunContext } from '../extensions/BuddyExtensionRunContext'
import type { ExecutionCoordinator } from './ExecutionCoordinator'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { currentPlatform } from '../../../../platform/currentPlatform'
import { MAX_BUDDY_MESSAGE_TEXT_LENGTH } from '../../../../shared/conversation/buddyMessageContent'
import { resolveShellExecution } from '../../sandbox/shellExecution'
import { ExecutionAdmissionError, executionFence, hashChildAdmissionRequest } from '../../storage/executionRepository'
import { getRoleToolDenial } from '../extensions/discovery/SessionToolScope'
import { isPiShellToolName } from '../extensions/piBuiltinTools'

export const delegationInputSchema = z.object({
  operation: z.enum(['list', 'delegate', 'status', 'send', 'wait', 'question', 'answer', 'cancel']),
  targetId: z.string().min(1).max(256).optional(),
  runId: z.string().min(1).max(256).optional(),
  text: z.string().trim().min(1).max(MAX_BUDDY_MESSAGE_TEXT_LENGTH).optional(),
  questionId: z.string().min(1).max(128).optional(),
  audience: z.enum(['caller', 'user']).optional(),
  timeoutMs: z.number().int().min(1).max(60000).optional(),
}).strict()

export type DelegationInput = z.infer<typeof delegationInputSchema>

interface DelegationCaller {
  run: BuddyExtensionRunContext
  getPermissions: () => BuddyPermissionSettings
}

export interface ExecutionDelegationServiceOptions {
  buddies: Pick<BuddiesService, 'get'>
  members: Pick<ConversationMemberRepository, 'list'>
  definitions: Pick<BuddyDefinitionResolver, 'capture'>
  executions: ExecutionRepository
  mailbox: MailboxRepository
  coordinator: Pick<ExecutionCoordinator, 'admitChild' | 'send' | 'wait' | 'answerQuestion' | 'cancel' | 'assertShellExecutionAllowed'>
  readToolOptions: (signal: AbortSignal) => Promise<readonly BuddyToolOption[]>
  stopExecution: (runId: string) => Promise<boolean>
  actorTargets?: (rootRunId: string) => readonly string[]
}

export class ExecutionDelegationService {
  readonly #options: ExecutionDelegationServiceOptions

  constructor(options: ExecutionDelegationServiceOptions) {
    this.#options = options
  }

  assertShellExecutionAllowed(runId: string): void {
    this.#options.coordinator.assertShellExecutionAllowed(runId)
  }

  async execute(caller: DelegationCaller, requestKey: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    const input = delegationInputSchema.parse(value)
    signal.throwIfAborted()
    const source = this.#require(caller.run.runId)
    this.#options.executions.assertCurrent(executionFence(source, this.#require(source.run.rootRunId)))
    if (input.operation === 'list')
      return this.#list(caller, source, signal)
    if (input.operation === 'delegate')
      return this.#delegate(caller, source, requestKey, input, signal)
    if (input.operation === 'question') {
      if (!input.text)
        throw new ExecutionAdmissionError('conflict')
      const target = input.audience === 'user' ? source : source.run.parentRunId ? this.#require(source.run.parentRunId) : null
      if (!target)
        throw new ExecutionAdmissionError('unauthorized')
      const questionId = createHash('sha256').update(JSON.stringify([source.run.id, requestKey])).digest('hex')
      await this.#options.coordinator.send(source.run.id, { messageId: questionId, questionId, kind: 'question', audience: input.audience ?? 'caller', targetRunId: target.run.id, targetGeneration: target.run.generation, text: input.text })
      return { questionId, status: 'waiting_for_answer', audience: input.audience ?? 'caller' }
    }
    if (input.operation === 'answer') {
      if (!input.questionId || !input.text)
        throw new ExecutionAdmissionError('conflict')
      await this.#options.coordinator.answerQuestion(source.run.id, input.questionId, input.text)
      return { questionId: input.questionId, status: 'accepted' }
    }
    const target = input.runId ? this.#requireRelated(source, input.runId) : source
    if (input.operation === 'send') {
      if (!input.text)
        throw new ExecutionAdmissionError('conflict')
      await this.#options.coordinator.send(source.run.id, { messageId: createHash('sha256').update(JSON.stringify([source.run.id, requestKey])).digest('hex'), kind: 'supplement', targetRunId: target.run.id, targetGeneration: target.run.generation, text: input.text })
      return { runId: target.run.id, status: 'accepted' }
    }
    if (input.operation === 'cancel') {
      if (target.run.parentRunId !== source.run.id)
        throw new ExecutionAdmissionError('unauthorized')
      await this.#options.coordinator.cancel(target.run.id, 'RUN_CANCELLED', this.#options.stopExecution)
    }
    if (input.operation === 'wait') {
      const pendingResults = new Set(this.#options.mailbox.listUnconsumed(source.run.id).filter(message => message.kind === 'result').map(message => message.sourceRunId))
      const targets = input.runId
        ? [target.run.id]
        : this.#options.executions.listTree(source.run.rootRunId)
            .filter(item => item.run.parentRunId === source.run.id && (item.phase !== 'closed' || pendingResults.has(item.run.id)))
            .map(item => item.run.id)
      await this.#options.coordinator.wait(source.run.id, targets, input.timeoutMs ?? 30000, signal)
    }
    return this.status(source.run.id, target.run.id)
  }

  status(callerId: string, targetId: string) {
    const source = this.#require(callerId)
    const target = this.#requireRelated(source, targetId)
    const summarize = (record: ExecutionStateRecord) => ({
      runId: record.run.id,
      actorId: record.run.buddyId,
      kind: record.run.executionKind,
      parentRunId: record.run.parentRunId,
      phase: record.phase,
      status: record.run.status,
      errorCode: record.run.errorCode,
      cleanup: record.cleanupState,
      questions: this.#options.mailbox.listQuestions(record.run.id).flatMap(question => question.kind === 'question' ? [{ questionId: question.questionId, text: question.text, audience: question.audience ?? 'caller', open: this.#options.mailbox.findQuestion(question.questionId)?.open ?? false }] : []),
    })
    return {
      ...summarize(target),
      children: this.#options.executions.listTree(target.run.rootRunId).filter(record => record.run.parentRunId === target.run.id).map(summarize),
      updates: this.#options.mailbox.listUnconsumed(callerId),
    }
  }

  #catalog(source: ExecutionStateRecord) {
    const snapshot = source.run.actorSnapshot
    if (!snapshot || snapshot.kind !== 'actor')
      return { actors: [], npcs: [] }
    const ids = [...snapshot.settings.npcIds, ...this.#options.members.list(source.run.conversationId).map(member => member.actorId)]
    const targets = this.#options.actorTargets?.(source.run.rootRunId) ?? []
    const available = [...new Set(ids)].flatMap((id) => {
      const buddy = this.#options.buddies.get(id)
      return buddy.enabled && !buddy.deletedAt && buddy.id !== source.run.buddyId
        && (buddy.kind === 'npc' || targets.length < 2 || targets.includes(buddy.id))
        ? [{ id: buddy.id, name: buddy.name, description: buddy.description, kind: buddy.kind }]
        : []
    })
    return { actors: available.filter(item => item.kind === 'actor'), npcs: available.filter(item => item.kind === 'npc') }
  }

  async #list(caller: DelegationCaller, source: ExecutionStateRecord, signal: AbortSignal) {
    const catalog = this.#catalog(source)
    if (!catalog.actors.length && !catalog.npcs.length)
      return catalog
    const toolOptions = await this.#options.readToolOptions(signal)
    signal.throwIfAborted()
    const permissions = caller.getPermissions()
    const describe = (target: (typeof catalog.npcs)[number]) => {
      const buddy = this.#options.buddies.get(target.id)
      const selection = buddy.settings.tools
      const selected = selection.mode === 'all' ? null : new Set(selection.mode === 'selected' ? selection.ids : [])
      const readOnly = permissions.executionProfile === 'read_only' || source.fileAccessCeiling === 'read_only'
        || source.run.actorSnapshot?.settings.limits.fileAccess === 'read_only' || buddy.settings.limits.fileAccess === 'read_only'
      const executionProfile = readOnly ? 'read_only' : permissions.executionProfile
      const tools = toolOptions.filter(tool => !getRoleToolDenial(tool.name, tool, selected, readOnly ? 'read_only' : 'inherit')
        && (currentPlatform.hostShellSupervision || !isPiShellToolName(tool.name)))
      const shell = resolveShellExecution(executionProfile)
      return {
        ...target,
        revision: buddy.revision,
        tools: tools.map(tool => tool.name),
        unavailableToolIds: [...selected ?? []].filter(id => !toolOptions.some(tool => tool.id === id)),
        executionProfile,
        shell: tools.some(tool => tool.name === shell.dialect) ? { tool: shell.dialect, boundary: shell.boundary, readOnly: shell.readOnly } : null,
      }
    }
    return { actors: catalog.actors.map(describe), npcs: catalog.npcs.map(describe) }
  }

  async #delegate(caller: DelegationCaller, source: ExecutionStateRecord, requestKey: string, input: DelegationInput, signal: AbortSignal) {
    if (!input.targetId || !input.text || source.run.actorSnapshot?.kind !== 'actor' || !caller.run.requestModel)
      throw new ExecutionAdmissionError('unauthorized')
    const catalog = this.#catalog(source)
    const target = [...catalog.actors, ...catalog.npcs].find(item => item.id === input.targetId)
    if (!target)
      throw new ExecutionAdmissionError('unauthorized')
    const rootGeneration = this.#require(source.run.rootRunId).run.generation
    const { definition } = await this.#options.definitions.capture({
      buddyId: target.id,
      kind: target.kind,
      conversationId: source.run.conversationId,
      callerModel: caller.run.requestModel,
    })
    signal.throwIfAborted()
    const permissions = caller.getPermissions()
    const readOnly = source.fileAccessCeiling === 'read_only' || source.run.actorSnapshot.settings.limits.fileAccess === 'read_only' || definition.settings.limits.fileAccess === 'read_only'
    const id = randomUUID()
    const request: AdmitChildExecutionInput = {
      callerId: source.run.id,
      expectedCallerGeneration: source.run.generation,
      expectedRootGeneration: rootGeneration,
      authorization: { ...permissions, ...(readOnly ? { fileAccessCeiling: 'read_only' as const } : {}) },
      requestKey,
      requestHash: '',
      resultMailboxId: randomUUID(),
      run: {
        id,
        buddyId: definition.id,
        actorSnapshot: definition,
        conversationId: source.run.conversationId,
        branchId: source.run.branchId,
        triggeringMessageId: randomUUID(),
        provider: definition.model.providerId,
        model: definition.model.modelId,
        purpose: source.run.purpose,
        approvalPolicy: permissions.approvalPolicy,
        executionProfile: readOnly ? 'read_only' : permissions.executionProfile,
        executionContext: source.run.executionContext,
        startedAt: new Date().toISOString(),
      },
      initialInput: { prompt: input.text, attachmentIds: [], contextItems: [], reasoning: definition.model.reasoning, serviceTier: definition.model.serviceTier },
    }
    request.requestHash = hashChildAdmissionRequest(request)
    const accepted = await this.#options.coordinator.admitChild(request)
    return { runId: accepted.run.id, actorId: accepted.run.buddyId, kind: accepted.run.executionKind, status: accepted.run.status, phase: accepted.phase }
  }

  #require(id: string): ExecutionStateRecord {
    const record = this.#options.executions.find(id)
    if (!record)
      throw new ExecutionAdmissionError('stale')
    return record
  }

  #requireRelated(source: ExecutionStateRecord, id: string): ExecutionStateRecord {
    const target = this.#require(id)
    if (target.run.rootRunId !== source.run.rootRunId || (target.run.id !== source.run.id && target.run.parentRunId !== source.run.id))
      throw new ExecutionAdmissionError('unauthorized')
    return target
  }
}
