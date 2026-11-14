import type { BuddyComposerDraftScope } from '../../../shared/conversation/composerDraft'
import type { UserQuestionRequest } from '../../../shared/questions/userQuestionApi'
import type { BuddyAgentRunner } from '../agent/execution/BuddyAgentRunner'
import type { BuddyTurnLauncher } from '../agent/execution/BuddyTurnLauncher'
import type {
  AttachmentService,
} from '../attachments/AttachmentService'
import type { ComposerResourceService } from '../attachments/ComposerResourceService'
import type { BuddyDefinitionResolver } from '../buddies/BuddyDefinitionResolver'
import type {
  BuddyStartTurnInput,
  BuddyTurnStart,
} from '../BuddyRuntime'
import type { ConversationLifecycleService } from '../conversations/ConversationLifecycleService'
import type {
  RuntimeModelProvider,
} from '../providers/resolveInteractiveModelSelection'
import type { SkillService } from '../skills/SkillService'
import type { QueuedTurnRequestInput } from '../storage/chatQueueRepository'
import type { ComposerDraftRepository } from '../storage/composerDraftRepository'
import type { ConversationHistoryRepository } from '../storage/conversationHistoryRepository'
import type { ConversationRecord } from '../storage/conversationRecord'
import type { ConversationRepository } from '../storage/conversationRepository'
import type {
  RunInputRecord,
  RunInputRepository,
} from '../storage/runInputRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { SpaceRecord, SpaceRepository } from '../storage/spaceRepository'
import type {
  EditTurnRequestInput,
  PrepareTurnRequestInput,
  RegenerateTurnRequestInput,
  TurnRequestRecord,
  TurnRequestRepository,
} from '../storage/turnRequestRepository'
import type { TurnReplay } from './ChatInputMaterializer'
import type { ChatInputValidationService } from './ChatInputValidationService'
import type { ChatInputSource } from './resolveChatInput'
import { createHash, randomUUID } from 'node:crypto'

import {
  buddyUserMessageContentV1Schema,
  createBuddyUserContent,
  getBuddyUserContentActorReferences,
  readBuddyUserMessageContent,
} from '../../../shared/conversation/buddyUserContent'
import { AsyncOperationScope } from '../../../shared/lifecycle/AsyncOperationScope'
import { isExecutionProfileWithin } from '../../../shared/permissions/executionProfile'
import { renderUserQuestionReply, userQuestionReplyText } from '../../../shared/questions/userQuestionReply'
import { canReadReferenceSnapshots } from '../conversations/referenceSnapshotToolContract'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { toPublicRun } from '../runs/publicRun'

import { requireActiveSpace } from '../spaces/requireActiveSpace'
import { isReviewUserMessage } from './buddyReviewPrompt'
import { assertPromptSize, ChatInputMaterializer, normalizeThinkingLevel, toModelParameters } from './ChatInputMaterializer'
import { ChatInputPreparation } from './ChatInputPreparation'
import { createConversationTitle } from './conversationTitle'
import { persistPreparedTurn } from './persistPreparedTurn'
import { resolveChatInput } from './resolveChatInput'
import { resolveAuthorizedSessionReferences } from './sessionReferenceAuthorization'

export type PreparedStartTurnInput = ChatInputSource & Omit<BuddyStartTurnInput, 'draftId' | 'expectedRevision'>

export type EditChatUserMessageInput = ChatInputSource & {
  conversationId: string
  requestId: string
  userMessageId: string
}

export interface RegenerateChatAssistantInput {
  conversationId: string
  requestId: string
  sourceRunId: string
}

export interface ChatTurnServiceOptions {
  definitions: Pick<BuddyDefinitionResolver, 'resolve' | 'validateActors'>
  getDefaultBuddyId: () => string
  composerResources?: Pick<ComposerResourceService, 'resolveInput'>
  attachments: Pick<
    AttachmentService,
    'getInputMetadata' | 'prepareMessageAttachments' | 'preparePrompt'
  >
  conversationLifecycle: Pick<ConversationLifecycleService, 'isDeleting'>
  conversations: Pick<ConversationRepository, 'findById'>
    & Pick<ConversationHistoryRepository, 'listBranchMessages'>
  drafts: Pick<ComposerDraftRepository, 'findById'>
  spaces: Pick<SpaceRepository, 'findById'>
  providers: RuntimeModelProvider
  inputValidation: Pick<ChatInputValidationService, 'validate'>
  runInputs: Pick<RunInputRepository, 'findByRunId'>
  runner: Pick<BuddyAgentRunner, 'cancel'>
  runs: Pick<RunRepository, 'findById'>
  skills: Pick<SkillService, 'materializeForSpace'>
  turnLauncher: Pick<BuddyTurnLauncher, 'launch'>
  turnRequests: TurnRequestRepository
}

export class ChatTurnService {
  readonly #options: ChatTurnServiceOptions
  readonly #stopping = new AbortController()
  readonly #operations = new AsyncOperationScope(() => this.#stopping.signal.reason)
  readonly #materials: ChatInputMaterializer
  readonly #preparation: ChatInputPreparation

  constructor(options: ChatTurnServiceOptions) {
    this.#options = options
    this.#materials = new ChatInputMaterializer({ attachments: options.attachments, definitions: options.definitions, inputValidation: options.inputValidation, providers: options.providers, runInputs: options.runInputs, skills: options.skills })
    this.#preparation = new ChatInputPreparation({ definitions: options.definitions, resources: options.composerResources, attachments: options.attachments, materials: this.#materials })
  }

  get hasPendingOperations(): boolean {
    return this.#operations.hasPending
  }

  start(input: BuddyStartTurnInput): Promise<BuddyTurnStart> {
    return this.#run(() => this.#start({ ...input }))
  }

  async #start(input: BuddyStartTurnInput): Promise<BuddyTurnStart> {
    const replay = this.#findReplay(
      input.requestId,
      createStartTurnFingerprint(input),
    )
    if (replay)
      return this.#toTurnStart(replay.request, replay.run)
    if (input.delivery?.target)
      throw new BuddyServiceError('INPUT_DELIVERY_INCOMPATIBLE')
    const { prepared, stagedAttachments } = await this.prepareStart(input)
    const request = await persistPreparedTurn(stagedAttachments, () => {
      this.#stopping.signal.throwIfAborted()
      return this.#options.turnRequests.prepare(prepared)
    })
    return this.#launchPreparedTurn(request)
  }

  continueQuestion(request: UserQuestionRequest, owner: RunRecord): Promise<string> {
    return this.#run(() => this.#continueQuestion(request, owner))
  }

  async #continueQuestion(request: UserQuestionRequest, owner: RunRecord): Promise<string> {
    const requestId = `question-reply:${request.id}`
    const previous = this.#options.turnRequests.findByRequestId(requestId)
    if (previous)
      return previous.runId
    const conversation = this.#requireActiveConversation(request.conversationId)
    const resolved = await this.#options.definitions.resolve({ buddyId: owner.buddyId, kind: 'actor', conversationId: conversation.id, requestedModel: null })
    const prompt = `The user answered an earlier question. Continue the original task using this answer. If the source was an NPC, resume that work only when needed. Existing permissions still apply.\n${renderUserQuestionReply(request)}`
    const selection = resolved.selection
    await this.#options.inputValidation.validate({ actorId: owner.buddyId, threadId: owner.threadId, conversationId: conversation.id, branchId: request.branchId, modelId: selection.modelId, providerId: selection.providerId, contextWindow: selection.contextWindow, maxTokens: selection.maxTokens, prompt, attachments: [] })
    this.#stopping.signal.throwIfAborted()
    const source = this.#options.runs.findById(request.runId)
    const ceiling = isReviewUserMessage(this.#options.conversations.listBranchMessages(conversation.id, request.branchId).find(message => message.id === owner.triggeringMessageId)?.content)
      ? 'read_only'
      : source?.executionProfile ?? owner.executionProfile
    const prepared = this.#options.turnRequests.prepare({
      questionReply: { requestId: request.id, sourceRunId: request.runId },
      draft: null,
      requestId,
      requestFingerprint: createHash('sha256').update(renderUserQuestionReply(request)).digest('hex'),
      conversationId: conversation.id,
      branchId: request.branchId,
      spaceId: conversation.spaceId,
      buddyId: owner.buddyId,
      actorIds: [owner.buddyId],
      actorSnapshot: resolved.definition,
      expectedActorModelSelection: resolved.memberModelSelection,
      approvalPolicy: conversation.approvalPolicy,
      executionProfile: conversation.executionProfile,
      runExecutionProfile: isExecutionProfileWithin(conversation.executionProfile, ceiling) ? conversation.executionProfile : ceiling,
      model: selection.modelId,
      provider: selection.providerId,
      modelParameters: toModelParameters(selection),
      runInput: { prompt, attachmentIds: [], contextItems: [], reasoning: normalizeThinkingLevel(selection.reasoning) ?? null, serviceTier: selection.serviceTier },
      runId: randomUUID(),
      userMessageId: randomUUID(),
      title: null,
      createdAt: new Date().toISOString(),
      attachmentBindings: [],
      userMessageContent: { userContent: createBuddyUserContent(userQuestionReplyText(request)), resourceSnapshots: [], questionReply: { requestId: request.id } },
    })
    await this.#launchPreparedTurn(prepared)
    return prepared.runId
  }

  async prepareStart(input: PreparedStartTurnInput) {
    this.#stopping.signal.throwIfAborted()
    const draft = resolveChatInput(input, this.#options.drafts)
    if (draft.scope.kind === 'message_edit')
      throw new BuddyServiceError('VALIDATION_FAILED')
    const followupScope = draft.scope.kind === 'message_followup' ? draft.scope : null
    const scope = resolveDraftScope(draft.scope)
    if (scope.conversationId && this.#options.conversationLifecycle.isDeleting(scope.conversationId))
      throw new BuddyServiceError('VALIDATION_FAILED')
    const existingConversation = scope.conversationId
      ? this.#options.conversations.findById(scope.conversationId)
      : null
    if (scope.conversationId && !existingConversation)
      throw new BuddyServiceError('VALIDATION_FAILED')
    if (existingConversation && input.buddyId !== undefined)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const leaderId = existingConversation?.buddyId ?? input.buddyId ?? draft.participants?.leaderId ?? this.#options.getDefaultBuddyId()
    const actorIds = [...new Set(getBuddyUserContentActorReferences(draft.content).map(reference => reference.actorId))]
    if (!existingConversation && actorIds.some(id => !(draft.participants?.actorIds ?? [leaderId]).includes(id)))
      throw new BuddyServiceError('BUDDY_NOT_MEMBER')
    const buddyId = input.delivery?.actorId ?? (actorIds.length === 1 ? actorIds[0]! : leaderId)
    if (input.delivery && (followupScope || buddyId !== (actorIds.length === 1 ? actorIds[0]! : leaderId)))
      throw new BuddyServiceError('INPUT_DELIVERY_INCOMPATIBLE')
    const spaceId = scope.spaceId ?? existingConversation?.spaceId ?? null
    const space = spaceId
      ? requireActiveSpace(this.#options.spaces.findById(spaceId))
      : null
    const sessionReferences = resolveAuthorizedSessionReferences(draft.content.sessionReferences ?? [], this.#options.conversations)
    const conversationId = scope.conversationId ?? randomUUID()
    if (
      existingConversation
      && (
        existingConversation.spaceId !== (space?.id ?? null)
        || existingConversation.approvalPolicy !== draft.executionConfig.approvalPolicy
        || existingConversation.executionProfile !== draft.executionConfig.executionProfile
      )
    ) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    const parentBranchId = scope.branchId
      ?? existingConversation?.activeBranchId
      ?? randomUUID()
    const branchId = followupScope ? randomUUID() : parentBranchId
    let followup: { parentBranchId: string, sourceMessageId: string, sourceRunId: string } | undefined
    if (followupScope) {
      const history = this.#options.conversations.listBranchMessages(conversationId, followupScope.branchId)
      const source = history.find(message => message.id === followupScope.assistantMessageId)
      const sourceRun = source?.runId ? this.#options.runs.findById(source.runId) : null
      if (!source || source.role !== 'assistant' || source.branchId !== followupScope.branchId
        || !sourceRun || sourceRun.status !== 'completed') {
        throw new BuddyServiceError('VALIDATION_FAILED')
      }
      followup = { parentBranchId: followupScope.branchId, sourceMessageId: source.id, sourceRunId: sourceRun.id }
    }
    if (this.#options.conversationLifecycle.isDeleting(conversationId))
      throw new BuddyServiceError('VALIDATION_FAILED')

    return this.#preparation.prepare({ draft, buddyId, actorIds, newParticipants: !existingConversation ? draft.participants?.actorIds ?? [leaderId] : undefined, conversationId, existingConversationId: existingConversation?.id ?? null, branchId: parentBranchId, space, sessionReferences, point: !existingConversation ? { kind: 'empty' } : followup ? { kind: 'after_run', runId: followup.sourceRunId, messageId: followup.sourceMessageId } : undefined }, (fields, records): PrepareTurnRequestInput => ({
      ...fields,
      ...(input.delivery ? { delivery: input.delivery } : {}),
      leaderId,
      followup,
      approvalPolicy: draft.executionConfig.approvalPolicy,
      branchId,
      conversationId,
      participants: draft.participants,
      executionProfile: draft.executionConfig.executionProfile,
      spaceId: space?.id ?? null,
      requestFingerprint: createStartTurnFingerprint(input),
      requestId: input.requestId,
      title: createConversationTitle(draft.content, records),
    }))
  }

  async refreshQueuedInput(input: QueuedTurnRequestInput): Promise<QueuedTurnRequestInput> {
    const conversation = this.#options.conversations.findById(input.conversationId)
    if (!conversation || conversation.deletedAt || this.#options.conversationLifecycle.isDeleting(input.conversationId))
      throw new BuddyServiceError('VALIDATION_FAILED')
    const buddyId = input.delivery?.actorId ?? (input.queueRouting?.mode === 'actor' ? input.queueRouting.actorId : conversation.buddyId)
    if (buddyId !== input.buddyId)
      throw new BuddyServiceError('BUDDY_CONFLICT')
    const resolved = await this.#options.definitions.resolve({ buddyId, kind: 'actor', conversationId: conversation.id, requestedModel: input.modelOverride ?? null })
    const selection = resolved.selection
    const projection = readBuddyUserMessageContent(input.userMessageContent)?.materialProjection
    if ((projection?.deferredReferences || projection?.deferredResourceIds.length)
      && (selection.toolCall === false || !canReadReferenceSnapshots(resolved.definition.settings.tools))) {
      throw new BuddyServiceError('MODEL_INPUT_UNSUPPORTED')
    }
    return {
      ...input,
      expectedActorModelSelection: resolved.memberModelSelection,
      actorSnapshot: resolved.definition,
      buddyId,
      model: selection.modelId,
      provider: selection.providerId,
      modelParameters: toModelParameters(selection),
      runInput: { ...input.runInput, reasoning: normalizeThinkingLevel(selection.reasoning) ?? null, serviceTier: selection.serviceTier },
    }
  }

  async validatePreparedInput(input: PrepareTurnRequestInput, validateSkills = true): Promise<void> {
    this.#options.definitions.validateActors([input.buddyId ?? this.#options.getDefaultBuddyId(), ...input.actorIds ?? []])
    if (validateSkills)
      input.runInput.contextItems = await this.#materials.validateSkills(input.spaceId, input.runInput.contextItems)
    await this.#options.inputValidation.validate({
      actorId: input.buddyId ?? this.#options.getDefaultBuddyId(),
      conversationId: input.conversationId,
      branchId: input.branchId,
      modelId: input.model,
      providerId: input.provider,
      contextWindow: input.modelParameters?.contextWindow ?? null,
      maxTokens: input.modelParameters?.maxTokens ?? null,
      prompt: input.runInput.prompt,
      attachments: this.#options.attachments.getInputMetadata(input.runInput.attachmentIds, input.conversationId, input.queuedMessageId ?? input.draft?.draftId ?? null),
    })
  }

  editUserMessage(input: EditChatUserMessageInput) {
    return this.#run(() => this.#editUserMessage({ ...input }))
  }

  async #editUserMessage(input: EditChatUserMessageInput) {
    const replay = this.#findReplay(input.requestId, createEditUserMessageFingerprint(input), input.conversationId)
    if (replay)
      return this.#toTurnStart(replay.request, replay.run)
    const { prepared, stagedAttachments } = await this.prepareEdit(input)
    const request = await persistPreparedTurn(stagedAttachments, () => {
      this.#stopping.signal.throwIfAborted()
      return this.#options.turnRequests.edit(prepared)
    })
    return this.#launchPreparedTurn(request)
  }

  async prepareEdit(input: EditChatUserMessageInput) {
    this.#stopping.signal.throwIfAborted()
    const conversation = this.#requireActiveConversation(input.conversationId)
    const draft = resolveChatInput(input, this.#options.drafts)
    if (draft.scope.kind !== 'message_edit')
      throw new BuddyServiceError('VALIDATION_FAILED')
    const parentBranchId = draft.scope.branchId
    const history = this.#options.conversations.listBranchMessages(
      conversation.id,
      parentBranchId,
    )
    const sourceIndex = history.findIndex(message => message.id === input.userMessageId)
    const sourceMessage = sourceIndex >= 0 ? history[sourceIndex] : null
    if (sourceMessage?.role !== 'user')
      throw new BuddyServiceError('VALIDATION_FAILED')
    if ((
      draft.scope.kind !== 'message_edit'
      || draft.scope.conversationId !== conversation.id
      || draft.scope.branchId !== parentBranchId
      || draft.scope.userMessageId !== input.userMessageId
      || draft.executionConfig.approvalPolicy !== conversation.approvalPolicy
      || draft.executionConfig.executionProfile !== conversation.executionProfile
    )) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    const forkedFromMessageId = sourceIndex > 0 ? history[sourceIndex - 1]?.id ?? null : null
    const space = this.#resolveConversationSpace(conversation)
    const sessionReferences = resolveAuthorizedSessionReferences(draft.content.sessionReferences ?? [], this.#options.conversations)
    const actorIds = [...new Set(getBuddyUserContentActorReferences(draft.content).map(reference => reference.actorId))]
    const buddyId = actorIds.length === 1 ? actorIds[0]! : conversation.buddyId
    return this.#preparation.prepare({ draft, buddyId, actorIds, conversationId: conversation.id, existingConversationId: conversation.id, branchId: parentBranchId, space, sessionReferences, point: { kind: 'before_message', messageId: input.userMessageId } }, (fields): EditTurnRequestInput => ({
      ...fields,
      approvalPolicy: conversation.approvalPolicy,
      branchId: randomUUID(),
      conversationId: conversation.id,
      executionProfile: conversation.executionProfile,
      forkedFromMessageId,
      parentBranchId,
      spaceId: space?.id ?? null,
      requestFingerprint: createEditUserMessageFingerprint(input),
      requestId: input.requestId,
      sourceUserMessageId: input.userMessageId,
      title: null,
    }))
  }

  regenerateAssistant(input: RegenerateChatAssistantInput) {
    return this.#run(() => this.#regenerateAssistant({ ...input }))
  }

  async #regenerateAssistant(input: RegenerateChatAssistantInput) {
    const replay = this.#findReplay(input.requestId, createRegenerationFingerprint(input), input.conversationId)
    if (replay)
      return this.#toTurnStart(replay.request, replay.run)
    const prepared = await this.prepareRegenerate(input)
    const request = this.#options.turnRequests.regenerate(prepared)
    return this.#launchPreparedTurn(request)
  }

  async prepareRegenerate(input: RegenerateChatAssistantInput): Promise<RegenerateTurnRequestInput> {
    this.#stopping.signal.throwIfAborted()
    const conversation = this.#requireActiveConversation(input.conversationId)
    const sourceRun = this.#options.runs.findById(input.sourceRunId)
    if (!sourceRun || sourceRun.conversationId !== conversation.id || sourceRun.purpose === 'conversation.compaction')
      throw new BuddyServiceError('VALIDATION_FAILED')
    const parentBranchId = sourceRun.branchId
    const history = this.#options.conversations.listBranchMessages(conversation.id, parentBranchId)
    const triggerIndex = history.findIndex(message => message.id === sourceRun.triggeringMessageId)
    if (triggerIndex < 0)
      throw new BuddyServiceError('VALIDATION_FAILED')

    const storedInput = this.#requireRunInput(sourceRun.id)
    const sourceContent = buddyUserMessageContentV1Schema.safeParse(history[triggerIndex]!.content)
    const actorIds = sourceContent.success ? [...new Set(getBuddyUserContentActorReferences(sourceContent.data.userContent).map(reference => reference.actorId))] : []
    const buddyId = actorIds.length === 1 ? actorIds[0]! : conversation.buddyId
    const resolvedActor = await this.#options.definitions.resolve({ buddyId, kind: 'actor', conversationId: conversation.id })
    const selectedModel = resolvedActor.selection
    await this.#materials.validateSkills(conversation.spaceId, storedInput.contextItems)
    assertPromptSize(storedInput.prompt)
    await this.#options.inputValidation.validate({
      actorId: buddyId,
      conversationId: conversation.id,
      branchId: parentBranchId,
      point: { kind: 'before_message', messageId: sourceRun.triggeringMessageId },
      modelId: selectedModel.modelId,
      providerId: selectedModel.providerId,
      contextWindow: selectedModel.contextWindow,
      maxTokens: selectedModel.maxTokens,
      prompt: storedInput.prompt,
      attachments: this.#options.attachments.getInputMetadata(storedInput.attachmentIds, conversation.id),
    })
    const runId = randomUUID()
    this.#stopping.signal.throwIfAborted()
    return {
      actorIds,
      expectedActorModelSelection: resolvedActor?.memberModelSelection,
      actorSnapshot: resolvedActor?.definition,
      buddyId,
      approvalPolicy: conversation.approvalPolicy,
      branchId: randomUUID(),
      conversationId: conversation.id,
      createdAt: new Date().toISOString(),
      executionProfile: conversation.executionProfile,
      model: selectedModel.modelId,
      provider: selectedModel.providerId,
      modelParameters: toModelParameters(selectedModel),
      reasoning: normalizeThinkingLevel(selectedModel.reasoning) ?? null,
      serviceTier: selectedModel.serviceTier,
      expectedModelSelection: conversation.modelSelection,
      runExecutionProfile: isReviewUserMessage(history[triggerIndex]!.content) ? 'read_only' : undefined,
      forkedFromMessageId: requireValue(sourceRun).triggeringMessageId,
      parentBranchId,
      requestFingerprint: createRegenerationFingerprint(input),
      requestId: input.requestId,
      runId,
      sourceRunId: requireValue(sourceRun).id,
    }
  }

  launchAccepted(runId: string): Promise<void> {
    return this.#run(async () => {
      const turn = await this.#options.turnLauncher.launch(runId, this.#stopping.signal)
      void turn.completion.catch(() => {})
    })
  }

  async cancel(runId: string) {
    await this.#options.runner.cancel(runId)
    return this.#publicRun(this.#requireRun(runId))
  }

  #findReplay(
    requestId: string,
    requestFingerprint: string,
    conversationId?: string,
  ): TurnReplay | null {
    const request = this.#options.turnRequests.findByRequestId(requestId)
    if (!request)
      return null
    if (
      request.requestFingerprint !== requestFingerprint
      || (conversationId !== undefined && request.conversationId !== conversationId)
    ) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    return { request, run: this.#requireRun(request.runId) }
  }

  async #launchPreparedTurn(prepared: TurnRequestRecord) {
    if (!prepared.created)
      return this.#toTurnStart(prepared, this.#requireRun(prepared.runId))
    const turn = await this.#options.turnLauncher.launch(prepared.runId, this.#stopping.signal)
    void turn.completion.catch(() => {})
    return this.#toTurnStart(prepared, this.#requireRun(turn.runId))
  }

  async dispose(): Promise<void> {
    this.#operations.stopAccepting()
    this.#stopping.abort()
    await this.#operations.drain()
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    return this.#operations.track(operation)
  }

  #publicRun(run: RunRecord) {
    return toPublicRun(run, this.#options.runInputs.findByRunId(run.id)?.reasoning ?? null)
  }

  #requireActiveConversation(conversationId: string): ConversationRecord {
    const conversation = requireValue(this.#options.conversations.findById(conversationId))
    if (this.#options.conversationLifecycle.isDeleting(conversation.id))
      throw new BuddyServiceError('VALIDATION_FAILED')
    return conversation
  }

  #requireRun(runId: string): RunRecord {
    return requireValue(this.#options.runs.findById(runId))
  }

  #requireRunInput(runId: string): RunInputRecord {
    return requireValue(this.#options.runInputs.findByRunId(runId))
  }

  #resolveConversationSpace(conversation: ConversationRecord): SpaceRecord | null {
    return conversation.spaceId
      ? requireActiveSpace(this.#options.spaces.findById(conversation.spaceId))
      : null
  }

  #toTurnStart(request: TurnRequestRecord, run: RunRecord): BuddyTurnStart {
    return {
      branchId: request.branchId,
      conversationId: request.conversationId,
      draftReceipt: request.draftReceipt,
      run: this.#publicRun(run),
      runId: request.runId,
    }
  }
}

function createStartTurnFingerprint(input: PreparedStartTurnInput): string {
  return fingerprint({ ...input, requestId: undefined })
}

function resolveDraftScope(scope: BuddyComposerDraftScope): {
  branchId: string | null
  conversationId: string | null
  spaceId: string | null
} {
  switch (scope.kind) {
    case 'global': return { branchId: null, conversationId: null, spaceId: null }
    case 'task':
    case 'space': return { branchId: null, conversationId: null, spaceId: scope.spaceId }
    case 'conversation_branch': return {
      branchId: scope.branchId,
      conversationId: scope.conversationId,
      spaceId: null,
    }
    case 'message_edit':
    case 'message_followup': return {
      branchId: scope.branchId,
      conversationId: scope.conversationId,
      spaceId: null,
    }
  }
}

function createEditUserMessageFingerprint(input: EditChatUserMessageInput): string {
  return fingerprint({
    ...input,
    operation: 'edit-user-message',
    requestId: undefined,
  })
}

function createRegenerationFingerprint(input: RegenerateChatAssistantInput): string {
  return fingerprint({
    conversationId: input.conversationId,
    operation: 'regenerate-assistant',
    sourceRunId: input.sourceRunId,
  })
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex')
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function requireValue<T>(value: T | null): T {
  if (value === null)
    throw new BuddyServiceError('VALIDATION_FAILED')
  return value
}
