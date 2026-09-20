import type {
  BuddyPromptDirective,
  BuddyUserContentV1,
  BuddyUserMessageResourceSnapshot,
} from '../../../shared/conversation/buddyUserContent'
import type { BuddyComposerDraftScope } from '../../../shared/conversation/composerDraft'
import type { BuddyThinkingLevel } from '../../../shared/conversation/modelSelection'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { BuddyAgentRunner } from '../agent/execution/BuddyAgentRunner'
import type { BuddyTurnLauncher } from '../agent/execution/BuddyTurnLauncher'
import type {
  AttachmentService,
} from '../attachments/AttachmentService'
import type { ComposerResourceService } from '../attachments/ComposerResourceService'
import type {
  BuddyStartTurnInput,
  BuddyTurnContextItem,
  BuddyTurnStart,
} from '../BuddyRuntime'
import type { ConversationLifecycleService } from '../conversations/ConversationLifecycleService'
import type {
  InteractiveModelSelection,
  RuntimeModelProvider,
} from '../providers/resolveInteractiveModelSelection'
import type { SkillService } from '../skills/SkillService'
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
  PrepareTurnRequestInput,
  TurnRequestRecord,
  TurnRequestRepository,
} from '../storage/turnRequestRepository'
import type { ChatInputHistoryPoint, ChatInputValidationService } from './ChatInputValidationService'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import {
  isBuddyReviewCommand,
  isRetiredBuddyPromptCommand,
  parseBuddyChatCommand,
} from '../../../shared/conversation/buddyChatCommands'
import {
  bindResourceAttachments,
  buddyUserContentToText,
  buddyUserMessageContentV1Schema,
  getResourceAttachmentIds,
} from '../../../shared/conversation/buddyUserContent'
import { isBuddyThinkingLevel } from '../../../shared/conversation/modelSelection'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { isExecutionProfileWithin } from '../../../shared/permissions/executionProfile'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'
import { getModelFileInputMimeTypes } from '../providers/modelCapabilities'
import { resolveInteractiveModelSelection } from '../providers/resolveInteractiveModelSelection'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { toPublicRun } from '../runs/publicRun'
import { SkillError } from '../skills/skillFiles'
import {
  formatBuddySkillPrompt,
} from '../skills/SkillService'
import { requireActiveSpace } from '../spaces/requireActiveSpace'
import { BUDDY_REVIEW_PROMPT, buildBuddyReviewPrompt } from './buddyReviewPrompt'
import { createConversationTitle } from './conversationTitle'
import { persistPreparedTurn } from './persistPreparedTurn'

const MAX_CONTEXT_FILE_BYTES = 1024 * 1024
const MAX_MODEL_INPUT_BYTES = 4 * 1024 * 1024
const PROMPT_SECTION_SEPARATOR = '\n\n---\n\n'

type ChatContextItem = BuddyTurnContextItem

export interface EditChatUserMessageInput {
  conversationId: string
  draftId: string
  expectedRevision: number
  requestId: string
  userMessageId: string
}

export interface RegenerateChatAssistantInput {
  conversationId: string
  requestId: string
  sourceRunId: string
}

export interface ChatTurnServiceOptions {
  record?: ApplicationDiagnosticReporter
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

interface TurnReplay {
  request: TurnRequestRecord
  run: RunRecord
}

interface TurnModelSelection extends Omit<InteractiveModelSelection, 'reasoning'> {
  api: string
  contextWindow: number | null
  input: Array<'text' | 'image'>
  fileInputMimeTypes: ReturnType<typeof getModelFileInputMimeTypes>
  maxTokens: number | null
  reasoning: string | null
}

interface PrepareTurnMaterializationInput {
  composer?: { content: BuddyUserContentV1, resourceIds: readonly string[], resources?: readonly BuddyUserMessageResourceSnapshot[] }
  attachmentIds: readonly string[]
  content: string
  contextItems: readonly ChatContextItem[]
  conversationId: string
  branchId: string
  point?: ChatInputHistoryPoint
  draftId: string
  space: SpaceRecord | null
  replay: TurnReplay | null
  requestedModel: InteractiveModelSelection | null
  preparedSelection?: TurnModelSelection
}

export class ChatTurnService {
  readonly #options: ChatTurnServiceOptions

  constructor(options: ChatTurnServiceOptions) {
    this.#options = options
  }

  async start(input: BuddyStartTurnInput): Promise<BuddyTurnStart> {
    const replay = this.#findReplay(
      input.requestId,
      createStartTurnFingerprint(input),
    )
    if (replay)
      return this.#toTurnStart(replay.request, replay.run)
    const { prepared, stagedAttachments } = await this.prepareStart(input)
    const request = await persistPreparedTurn(stagedAttachments, () => this.#options.turnRequests.prepare(prepared))
    return this.#launchPreparedTurn(request)
  }

  async prepareStart(input: BuddyStartTurnInput) {
    const draft = this.#options.drafts.findById(input.draftId)
    if (!draft || draft.revision !== input.expectedRevision)
      throw new BuddyServiceError('DRAFT_CONFLICT')
    if (draft.scope.kind === 'message_edit')
      throw new BuddyServiceError('VALIDATION_FAILED')
    const followupScope = draft.scope.kind === 'message_followup' ? draft.scope : null
    const content = buddyUserContentToText(draft.content).trim()
    const scope = resolveDraftScope(draft.scope)
    if (scope.conversationId && this.#options.conversationLifecycle.isDeleting(scope.conversationId))
      throw new BuddyServiceError('VALIDATION_FAILED')
    const existingConversation = scope.conversationId
      ? this.#options.conversations.findById(scope.conversationId)
      : null
    if (scope.conversationId && !existingConversation)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const spaceId = scope.spaceId ?? existingConversation?.spaceId ?? null
    const space = spaceId
      ? requireActiveSpace(this.#options.spaces.findById(spaceId))
      : null
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
    if (existingConversation && !followupScope && existingConversation.activeBranchId !== branchId)
      throw new BuddyServiceError('VALIDATION_FAILED')
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

    const selectedModel = await this.#resolveSelection(null, null, draft.modelSelection)
    const resourceInputs = await requireValue(this.#options.composerResources ?? null)
      .resolveInput(input.draftId, draft.content, {
        branchId: existingConversation ? parentBranchId : null,
        conversationId: existingConversation?.id ?? null,
        spaceId: space?.id ?? null,
      }, selectedModel)
    if (!content && resourceInputs.length === 0 && !draft.content.quotes?.length)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const attachmentIds = getResourceAttachmentIds(resourceInputs)

    const {
      attachmentPrompt,
      prompt,
      reviewRequested,
      contextItems: resolvedContextItems,
      selection,
      thinkingLevel,
    } = await this.#prepareTurnMaterialization({
      attachmentIds,
      composer: {
        content: draft.content,
        resourceIds: resourceInputs.map(resource => resource.resourceId),
        resources: resourceInputs,
      },
      content: '',
      contextItems: [],
      conversationId,
      draftId: input.draftId,
      branchId: parentBranchId,
      point: !existingConversation ? { kind: 'empty' } : followup ? { kind: 'after_run', runId: followup.sourceRunId, messageId: followup.sourceMessageId } : undefined,
      space,
      replay: null,
      requestedModel: draft.modelSelection,
      preparedSelection: selectedModel,
    })
    const runId = randomUUID()
    const userMessageId = randomUUID()
    const stagedAttachments = await this.#options.attachments.prepareMessageAttachments({
      attachmentIds,
      conversationId,
      draftId: input.draftId,
      messageId: userMessageId,
    })
    const persistedAttachmentIds = stagedAttachments.bindings.map(binding => binding.id)
    const prepared: PrepareTurnRequestInput = {
      followup,
      approvalPolicy: draft.executionConfig.approvalPolicy,
      attachmentBindings: stagedAttachments.bindings,
      branchId,
      conversationId,
      createdAt: new Date().toISOString(),
      draft: {
        draftId: input.draftId,
        expectedRevision: input.expectedRevision,
      },
      executionProfile: draft.executionConfig.executionProfile,
      runExecutionProfile: reviewRequested ? 'read_only' : undefined,
      model: selection.modelId,
      modelParameters: toModelParameters(selection),
      spaceId: space?.id ?? null,
      provider: selection.providerId,
      requestFingerprint: createStartTurnFingerprint(input),
      requestId: input.requestId,
      runInput: {
        attachmentIds: persistedAttachmentIds,
        contextItems: resolvedContextItems,
        prompt,
        reasoning: thinkingLevel ?? null,
        serviceTier: selection.serviceTier,
      },
      runId,
      title: createConversationTitle(draft.content, attachmentPrompt.records),
      userMessageContent: createPersistedUserMessageContent(
        draft.content,
        bindResourceAttachments(resourceInputs, persistedAttachmentIds),
      ),
      userMessageId,
    }
    return { prepared, stagedAttachments }
  }

  async validatePreparedInput(input: PrepareTurnRequestInput, validateSkills = true): Promise<void> {
    if (validateSkills)
      await this.#validateSkillItems(input.spaceId, input.runInput.contextItems)
    await this.#options.inputValidation.validate({
      conversationId: input.conversationId,
      branchId: input.branchId,
      modelId: input.model,
      providerId: input.provider,
      contextWindow: input.modelParameters?.contextWindow ?? null,
      maxTokens: input.modelParameters?.maxTokens ?? null,
      prompt: input.runInput.prompt,
      attachments: this.#options.attachments.getInputMetadata(input.runInput.attachmentIds, input.conversationId, input.queuedMessageId ?? input.draft.draftId),
    })
  }

  async editUserMessage(input: EditChatUserMessageInput) {
    const replay = this.#findReplay(
      input.requestId,
      createEditUserMessageFingerprint(input),
      input.conversationId,
    )
    if (replay && !isInterruptedRun(replay.run))
      return this.#toTurnStart(replay.request, replay.run)

    const conversation = this.#requireActiveConversation(input.conversationId)
    const parentBranchId = requireValue(conversation.activeBranchId)
    const history = this.#options.conversations.listBranchMessages(
      conversation.id,
      parentBranchId,
    )
    const sourceIndex = history.findIndex(message => message.id === input.userMessageId)
    const sourceMessage = sourceIndex >= 0 ? history[sourceIndex] : null
    if (sourceMessage?.role !== 'user')
      throw new BuddyServiceError('VALIDATION_FAILED')
    const draft = replay ? null : this.#options.drafts.findById(input.draftId)
    if (!replay && (!draft || draft.revision !== input.expectedRevision))
      throw new BuddyServiceError('DRAFT_CONFLICT')
    if (draft && (
      draft.scope.kind !== 'message_edit'
      || draft.scope.conversationId !== conversation.id
      || draft.scope.branchId !== parentBranchId
      || draft.scope.userMessageId !== input.userMessageId
      || draft!.executionConfig.approvalPolicy !== conversation.approvalPolicy
      || draft!.executionConfig.executionProfile !== conversation.executionProfile
    )) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    const forkedFromMessageId = sourceIndex > 0 ? history[sourceIndex - 1]?.id ?? null : null
    const space = this.#resolveConversationSpace(conversation)
    const content = draft ? buddyUserContentToText(draft.content).trim() : ''
    const selectedModel = draft ? await this.#resolveSelection(null, null, draft.modelSelection) : undefined
    const resourceInputs = draft
      ? await requireValue(this.#options.composerResources ?? null).resolveInput(
          draft.draftId,
          draft.content,
          { branchId: parentBranchId, conversationId: conversation.id, spaceId: space?.id ?? null },
          selectedModel,
        )
      : []
    if (!replay && !content && resourceInputs.length === 0 && !draft?.content.quotes?.length)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const attachmentIds = getResourceAttachmentIds(resourceInputs)
    const {
      prompt,
      replayInput,
      reviewRequested,
      contextItems: resolvedContextItems,
      selection,
      thinkingLevel,
    } = await this.#prepareTurnMaterialization({
      attachmentIds,
      composer: draft
        ? { content: draft.content, resourceIds: resourceInputs.map(resource => resource.resourceId), resources: resourceInputs }
        : undefined,
      content: '',
      contextItems: [],
      conversationId: conversation.id,
      draftId: input.draftId,
      branchId: parentBranchId,
      point: { kind: 'before_message', messageId: input.userMessageId },
      space,
      replay,
      requestedModel: draft?.modelSelection ?? null,
      preparedSelection: selectedModel,
    })
    const runId = randomUUID()
    const userMessageId = randomUUID()
    const stagedAttachments = replay
      ? null
      : await this.#options.attachments.prepareMessageAttachments({
          attachmentIds,
          conversationId: conversation.id,
          draftId: input.draftId,
          messageId: userMessageId,
        })
    const persistedAttachmentIds = replayInput?.attachmentIds
      ?? stagedAttachments?.bindings.map(binding => binding.id)
      ?? []
    const persistedResourceSnapshots = replay ? [] : bindResourceAttachments(resourceInputs, persistedAttachmentIds)
    const prepared = await persistPreparedTurn(stagedAttachments, () => (
      replay
        ? this.#options.turnRequests.retryInterrupted({
            createdAt: new Date().toISOString(),
            requestId: input.requestId,
            runId,
          })
        : this.#options.turnRequests.edit({
            approvalPolicy: conversation.approvalPolicy,
            attachmentBindings: stagedAttachments?.bindings ?? [],
            branchId: randomUUID(),
            conversationId: conversation.id,
            createdAt: new Date().toISOString(),
            draft: { draftId: input.draftId, expectedRevision: input.expectedRevision },
            executionProfile: conversation.executionProfile,
            runExecutionProfile: reviewRequested ? 'read_only' : undefined,
            forkedFromMessageId,
            model: selection.modelId,
            modelParameters: toModelParameters(selection),
            parentBranchId,
            spaceId: space?.id ?? null,
            provider: selection.providerId,
            requestFingerprint: createEditUserMessageFingerprint(input),
            requestId: input.requestId,
            runId,
            runInput: {
              attachmentIds: persistedAttachmentIds,
              contextItems: resolvedContextItems,
              prompt,
              reasoning: thinkingLevel ?? null,
              serviceTier: replayInput ? replayInput.serviceTier : selection.serviceTier,
            },
            sourceUserMessageId: input.userMessageId,
            title: null,
            userMessageContent: createPersistedUserMessageContent(
              draft!.content,
              persistedResourceSnapshots,
            ),
            userMessageId,
          })
    ))
    return this.#launchPreparedTurn(prepared)
  }

  async regenerateAssistant(input: RegenerateChatAssistantInput) {
    const replay = this.#findReplay(
      input.requestId,
      createRegenerationFingerprint(input),
      input.conversationId,
    )
    if (replay && !isInterruptedRun(replay.run))
      return this.#toTurnStart(replay.request, replay.run)

    const conversation = this.#requireActiveConversation(input.conversationId)
    const sourceRun = this.#options.runs.findById(input.sourceRunId)
    if (!sourceRun || sourceRun.conversationId !== conversation.id || sourceRun.purpose === 'conversation.compaction')
      throw new BuddyServiceError('VALIDATION_FAILED')
    const parentBranchId = sourceRun.branchId
    const history = this.#options.conversations.listBranchMessages(conversation.id, parentBranchId)
    const triggerIndex = history.findIndex(message => message.id === sourceRun.triggeringMessageId)
    if (triggerIndex < 0)
      throw new BuddyServiceError('VALIDATION_FAILED')

    const storedInput = this.#requireRunInput(requireValue(replay?.run ?? sourceRun).id)
    await this.#validateSkillItems(conversation.spaceId, storedInput.contextItems)
    assertPromptSize(storedInput.prompt)
    await this.#options.inputValidation.validate({
      conversationId: conversation.id,
      branchId: parentBranchId,
      point: { kind: 'before_message', messageId: sourceRun.triggeringMessageId },
      modelId: sourceRun.model,
      providerId: sourceRun.provider,
      contextWindow: sourceRun.contextWindow,
      maxTokens: sourceRun.maxTokens,
      prompt: storedInput.prompt,
      attachments: this.#options.attachments.getInputMetadata(storedInput.attachmentIds, conversation.id),
    })
    const runId = randomUUID()
    const prepared = replay
      ? this.#options.turnRequests.retryInterrupted({
          createdAt: new Date().toISOString(),
          requestId: input.requestId,
          runId,
        })
      : this.#options.turnRequests.regenerate({
          approvalPolicy: conversation.approvalPolicy,
          branchId: randomUUID(),
          conversationId: conversation.id,
          createdAt: new Date().toISOString(),
          executionProfile: conversation.executionProfile,
          runExecutionProfile: isExecutionProfileWithin(sourceRun.executionProfile, conversation.executionProfile)
            ? sourceRun.executionProfile
            : conversation.executionProfile,
          forkedFromMessageId: requireValue(sourceRun).triggeringMessageId,
          parentBranchId,
          requestFingerprint: createRegenerationFingerprint(input),
          requestId: input.requestId,
          runId,
          sourceRunId: requireValue(sourceRun).id,
        })
    return this.#launchPreparedTurn(prepared)
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
    safeDiagnosticReporter(this.#options.record)({
      event: prepared.created ? 'run.queued' : 'run.reused',
      level: 'info',
      runId: prepared.runId,
      conversationId: prepared.conversationId,
      branchId: prepared.branchId,
      requestId: prepared.requestId,
    })
    if (!prepared.created)
      return this.#toTurnStart(prepared, this.#requireRun(prepared.runId))
    const turn = await this.#options.turnLauncher.launch(prepared.runId)
    void turn.completion
    return this.#toTurnStart(prepared, this.#requireRun(turn.runId))
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

  async #prepareTurnMaterialization(input: PrepareTurnMaterializationInput) {
    const replayInput = input.replay ? this.#requireRunInput(input.replay.run.id) : null
    const directives = !replayInput && input.composer
      ? await materializeComposerDirectives(input.composer.content, input.space, this.#options.skills)
      : null
    const composer = directives && input.composer
      ? { ...input.composer, resolveDirective: directives.resolveDirective }
      : undefined
    const legacyContext = !replayInput && !composer
      ? await materializeContextItems(input.contextItems, input.space, this.#options.skills)
      : null
    const contextItems = replayInput?.contextItems ?? directives?.contextItems ?? legacyContext?.contextItems ?? input.contextItems
    if (replayInput)
      await this.#validateSkillItems(input.space?.id ?? null, contextItems)
    const attachmentPrompt = await this.#options.attachments.preparePrompt(
      replayInput?.attachmentIds ?? input.attachmentIds,
      replayInput ? '' : input.content,
      input.conversationId,
      replayInput ? null : input.draftId,
      composer,
    )
    const context = replayInput
      ? ''
      : [
          legacyContext?.prompt ?? '',
          directives?.contextSuffix ?? '',
        ].filter(Boolean).join(PROMPT_SECTION_SEPARATOR)
    const prompt = replayInput?.prompt
      ?? [attachmentPrompt.prompt, context].filter(Boolean).join(PROMPT_SECTION_SEPARATOR)
    assertPromptSize(prompt)
    const selection = input.preparedSelection ?? await this.#resolveSelection(
      input.replay?.run ?? null,
      replayInput,
      input.requestedModel,
    )
    await this.#options.inputValidation.validate({
      conversationId: input.conversationId,
      branchId: input.branchId,
      point: input.point,
      modelId: selection.modelId,
      providerId: selection.providerId,
      contextWindow: selection.contextWindow,
      maxTokens: selection.maxTokens,
      prompt,
      attachments: attachmentPrompt.records,
    })
    const thinkingLevel = normalizeThinkingLevel(
      replayInput ? replayInput.reasoning : selection.reasoning,
    )
    return {
      attachmentPrompt,
      prompt,
      contextItems,
      replayInput,
      reviewRequested: directives?.reviewRequested ?? false,
      selection,
      thinkingLevel,
    }
  }

  async #validateSkillItems(spaceId: string | null, items: readonly RunInputRecord['contextItems'][number][]) {
    const selections = items.filter(item => item.kind === 'skill').map(item => item.skill ?? item.value)
    await this.#options.skills.materializeForSpace(spaceId, selections)
  }

  #resolveConversationSpace(conversation: ConversationRecord): SpaceRecord | null {
    return conversation.spaceId
      ? requireActiveSpace(this.#options.spaces.findById(conversation.spaceId))
      : null
  }

  async #resolveSelection(
    replayRun: RunRecord | null,
    replayInput: RunInputRecord | null,
    requested: InteractiveModelSelection | null,
  ): Promise<TurnModelSelection> {
    if (replayRun) {
      const model = await this.#options.providers.executionModels.resolveAvailable({
        contextWindow: replayRun.contextWindow,
        maxTokens: replayRun.maxTokens,
        modelId: replayRun.model,
        providerId: replayRun.provider,
      })
      return {
        api: model.api,
        contextWindow: replayRun.contextWindow,
        input: model.input,
        fileInputMimeTypes: getModelFileInputMimeTypes(model),
        maxTokens: replayRun.maxTokens,
        modelId: replayRun.model,
        providerId: replayRun.provider,
        reasoning: replayInput?.reasoning ?? null,
        serviceTier: replayInput?.serviceTier ?? null,
      }
    }
    return resolveInteractiveModelSelection(this.#options.providers, requested)
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

async function materializeComposerDirectives(
  content: BuddyUserContentV1,
  space: SpaceRecord | null,
  skills: Pick<SkillService, 'materializeForSpace'>,
) {
  const directives = content.body.flatMap(paragraph => paragraph.content.filter(node => node.type === 'prompt_directive'))
  const textCommand = parseBuddyChatCommand(buddyUserContentToText(content))
  if (textCommand?.name === 'compact')
    throw new BuddyServiceError('VALIDATION_FAILED')
  const hasReviewDirective = directives.some(node => node.directive === 'slash_command' && isBuddyReviewCommand(node.value))
  const reviewsAsText = textCommand?.name === 'review' && !hasReviewDirective
  const selections = directives.flatMap(node => node.directive === 'skill' ? [node.skill ?? node.value] : [])
  const loaded = await skills.materializeForSpace(space?.id ?? null, selections)
  const selected = new Map(loaded.map(skill => [skill.name, formatBuddySkillPrompt(skill)]))
  return {
    reviewRequested: hasReviewDirective || reviewsAsText,
    contextSuffix: reviewsAsText ? BUDDY_REVIEW_PROMPT : '',
    contextItems: loaded.map(skill => ({ kind: 'skill' as const, value: skill.name, skill: skill.reference })),
    resolveDirective(directive: BuddyPromptDirective): string {
      if (directive.directive === 'skill') {
        const value = selected.get(directive.value)
        if (value === undefined)
          throw new SkillError('SKILL_NOT_FOUND')
        return value
      }
      if (isRetiredBuddyPromptCommand(directive.value))
        return directive.value
      if (isBuddyReviewCommand(directive.value) && directive.commandMode === 'prompt')
        return buildBuddyReviewPrompt(parseBuddyChatCommand(directive.value)!.arguments)
      throw new BuddyServiceError('VALIDATION_FAILED')
    },
  }
}

function createStartTurnFingerprint(input: BuddyStartTurnInput): string {
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

function createPersistedUserMessageContent(
  userContent: BuddyUserContentV1,
  resourceSnapshots: readonly BuddyUserMessageResourceSnapshot[],
) {
  return buddyUserMessageContentV1Schema.parse({
    resourceSnapshots: [...resourceSnapshots],
    userContent,
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

async function materializeContextItems(
  items: readonly ChatContextItem[],
  space: SpaceRecord | null,
  skills: Pick<SkillService, 'materializeForSpace'>,
) {
  const selectedSkills = await skills.materializeForSpace(
    space?.id ?? null,
    items.filter(item => item.kind === 'skill').map(item => item.skill ?? item.value),
  )
  const skillsByName = new Map(selectedSkills.map(skill => [skill.name, skill]))
  const sections: string[] = []
  for (const item of items) {
    if (item.kind === 'skill') {
      const skill = skillsByName.get(item.value)
      if (!skill)
        throw new BuddyServiceError('VALIDATION_FAILED')
      sections.push(formatBuddySkillPrompt(skill))
      continue
    }
    if (item.kind === 'slashCommand')
      continue
    if (!space)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const primaryDirectory = space.primaryDirectory
    const directories = [
      ...(primaryDirectory ? [primaryDirectory] : []),
      ...space.additionalDirectories,
    ]
    const requestedPath = isAbsolute(item.value)
      ? item.value
      : primaryDirectory ? join(primaryDirectory.canonicalRoot, item.value) : null
    if (!requestedPath)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const resolution = await resolveGrantedPath(directories.map(directory => ({
      canonicalRoot: directory.canonicalRoot,
      grantId: directory.id,
      kind: 'workspace' as const,
      root: directory.root,
    })), requestedPath, 'existing')
    const directory = directories.find(item => item.id === resolution.grantId)
    if (!directory)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const content = await readBoundedFile(directory.canonicalRoot, resolution.canonicalPath)
    if (content.byteLength > MAX_CONTEXT_FILE_BYTES)
      throw new BuddyServiceError('VALIDATION_FAILED')
    sections.push(`上下文文件：${item.value}\n\n${content.toString('utf8')}`)
  }
  return {
    prompt: sections.join(PROMPT_SECTION_SEPARATOR),
    contextItems: items.map(item => item.kind === 'skill' ? { ...item, skill: skillsByName.get(item.value)!.reference } : item),
  }
}

function normalizeThinkingLevel(value: string | null | undefined): BuddyThinkingLevel | undefined {
  if (!value)
    return undefined
  if (!isBuddyThinkingLevel(value))
    throw new BuddyServiceError('VALIDATION_FAILED')
  return value
}

function assertPromptSize(prompt: string): void {
  if (Buffer.byteLength(prompt) > MAX_MODEL_INPUT_BYTES)
    throw new BuddyServiceError('VALIDATION_FAILED')
}

function toModelParameters(selection: TurnModelSelection) {
  return selection.contextWindow !== null && selection.maxTokens !== null
    ? { contextWindow: selection.contextWindow, maxTokens: selection.maxTokens }
    : undefined
}

function isInterruptedRun(run: RunRecord): boolean {
  return run.status === 'failed' && run.errorCode === 'RUNTIME_RESTARTED'
}

function requireValue<T>(value: T | null): T {
  if (value === null)
    throw new BuddyServiceError('VALIDATION_FAILED')
  return value
}
