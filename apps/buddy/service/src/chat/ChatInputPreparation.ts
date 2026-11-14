import type { BuddyUserContentV1, BuddyUserMessageResourceSnapshot } from '../../../shared/conversation/buddyUserContent'
import type { InputMaterialProjectionState } from '../../../shared/conversation/inputMaterialProjection'
import type { AttachmentService } from '../attachments/AttachmentService'
import type { ComposerResourceService } from '../attachments/ComposerResourceService'
import type { BuddyDefinitionResolver } from '../buddies/BuddyDefinitionResolver'
import type { SpaceRecord } from '../storage/spaceRepository'
import type { PrepareTurnRequestInput } from '../storage/turnRequestRepository'
import type { ChatInputMaterializer } from './ChatInputMaterializer'
import type { ChatInputHistoryPoint } from './ChatInputValidationService'
import type { PreparedTurnAttachments } from './persistPreparedTurn'
import type { resolveChatInput } from './resolveChatInput'
import { randomUUID } from 'node:crypto'
import { bindResourceAttachments, buddyUserContentToText, buddyUserMessageContentV1Schema, getResourceAttachmentIds } from '../../../shared/conversation/buddyUserContent'
import { canReadReferenceSnapshots } from '../conversations/referenceSnapshotToolContract'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { toModelParameters } from './ChatInputMaterializer'
import { combinePreparedAttachments } from './persistPreparedTurn'

type PreparedInputFields = Pick<PrepareTurnRequestInput, 'expectedActorModelSelection' | 'actorSnapshot' | 'actorIds' | 'modelOverride' | 'buddyId' | 'attachmentBindings' | 'createdAt' | 'draft' | 'runExecutionProfile' | 'model' | 'modelParameters' | 'provider' | 'runInput' | 'runId' | 'userMessageContent' | 'userMessageId'>

interface PreparationOptions {
  definitions: Pick<BuddyDefinitionResolver, 'resolve' | 'validateActors'>
  resources?: Pick<ComposerResourceService, 'resolveInput'>
  attachments: Pick<AttachmentService, 'prepareMessageAttachments'>
  materials: ChatInputMaterializer
}

interface PreparationInput {
  draft: ReturnType<typeof resolveChatInput>
  buddyId: string
  actorIds: string[]
  newParticipants?: readonly string[]
  conversationId: string
  existingConversationId: string | null
  branchId: string
  space: SpaceRecord | null
  point?: ChatInputHistoryPoint
  sessionReferences: NonNullable<BuddyUserContentV1['sessionReferences']>
}

export class ChatInputPreparation {
  readonly #options: PreparationOptions

  constructor(options: PreparationOptions) {
    this.#options = options
  }

  async prepare<T>(input: PreparationInput, build: (fields: PreparedInputFields, records: Awaited<ReturnType<ChatInputMaterializer['prepare']>>['attachmentPrompt']['records']) => T): Promise<{ prepared: T, stagedAttachments: PreparedTurnAttachments }> {
    const { draft, buddyId, actorIds, conversationId, existingConversationId, branchId, space, sessionReferences } = input
    const resolvedActor = await this.#options.definitions.resolve({ buddyId, kind: 'actor', conversationId: existingConversationId, requestedModel: draft.modelSelection })
    const selectedModel = resolvedActor.selection
    this.#options.definitions.validateActors(actorIds, existingConversationId ?? undefined)
    if (input.newParticipants)
      this.#options.definitions.validateActors(input.newParticipants)
    if (!this.#options.resources)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const materialized = await this.#options.resources.resolveInput(draft.draftId, draft.content, { branchId: existingConversationId ? branchId : null, conversationId: existingConversationId, spaceId: space?.id ?? null }, selectedModel, draft.legacyResourceDraftId)
    let stagedAttachments: PreparedTurnAttachments | null = null
    try {
      const content = buddyUserContentToText(draft.content).trim()
      const resourceInputs = materialized.inputs
      if ((!content && draft.content.sessionReferences?.length) || (!content && resourceInputs.length === 0 && !draft.content.quotes?.length && !draft.content.resourceQuotes?.length))
        throw new BuddyServiceError('VALIDATION_FAILED')
      const attachmentIds = getResourceAttachmentIds(resourceInputs)
      const userMessageId = randomUUID()
      const { attachmentPrompt, prompt, reviewRequested, contextItems, selection, thinkingLevel } = await this.#options.materials.prepare({
        actorId: buddyId,
        attachmentIds,
        composer: { content: { ...draft.content, sessionReferences }, resourceIds: resourceInputs.map(resource => resource.resourceId), resources: resourceInputs, sourceMessageId: userMessageId, quoteReadAvailable: selectedModel.toolCall !== false && canReadReferenceSnapshots(resolvedActor.definition.settings.tools) },
        content: '',
        contextItems: [],
        conversationId,
        draftId: draft.draftId,
        legacyResourceDraftId: draft.legacyResourceDraftId,
        branchId,
        point: input.point,
        space,
        replay: null,
        requestedModel: draft.modelSelection,
        preparedSelection: selectedModel,
      })
      stagedAttachments = combinePreparedAttachments(await this.#options.attachments.prepareMessageAttachments({ attachmentIds, conversationId, draftId: draft.draftId, legacyResourceDraftId: draft.legacyResourceDraftId, messageId: userMessageId }), materialized)
      const persistedAttachmentIds = stagedAttachments.bindings.map(binding => binding.id)
      const fields: PreparedInputFields = {
        expectedActorModelSelection: resolvedActor.memberModelSelection,
        actorSnapshot: resolvedActor.definition,
        actorIds,
        ...(draft.modelSelection ? { modelOverride: draft.modelSelection } : {}),
        buddyId,
        attachmentBindings: stagedAttachments.bindings,
        createdAt: new Date().toISOString(),
        draft: draft.commit,
        runExecutionProfile: reviewRequested ? 'read_only' : undefined,
        model: selection.modelId,
        modelParameters: toModelParameters(selection),
        provider: selection.providerId,
        runInput: { attachmentIds: persistedAttachmentIds, contextItems, prompt, reasoning: thinkingLevel ?? null, serviceTier: selection.serviceTier },
        runId: randomUUID(),
        userMessageContent: createPersistedUserMessageContent({ ...draft.content, ...(sessionReferences.length ? { sessionReferences } : { sessionReferences: undefined }) }, bindResourceAttachments(resourceInputs, persistedAttachmentIds), attachmentPrompt.materialProjection),
        userMessageId,
      }
      return { prepared: build(fields, attachmentPrompt.records), stagedAttachments }
    }
    catch (error) {
      await (stagedAttachments ?? materialized).rollback().catch(() => undefined)
      throw error
    }
  }
}

function createPersistedUserMessageContent(
  userContent: BuddyUserContentV1,
  resourceSnapshots: readonly BuddyUserMessageResourceSnapshot[],
  materialProjection?: InputMaterialProjectionState,
) {
  return buddyUserMessageContentV1Schema.parse({
    resourceSnapshots: [...resourceSnapshots],
    ...(materialProjection?.deferredReferences || materialProjection?.deferredResourceIds.length ? { materialProjection } : {}),
    userContent,
  })
}
