import { z } from 'zod'
import {
  AgentClientActionResultSchema,
  AgentClientActionSchema,
} from './agent/client-action'
import {
  AGENT_DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_MAX_LENGTH,
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT,
  AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
  AgentDocumentAssistantSkillInvocationSchema,
} from './agent/document-assistant'
import { AgentToolCallStatusSchema } from './agent/events'
import { ChatGenerationUsageSnapshotSchema } from './agent/generation'
import { AgentMemoryRunOptionsSchema, ChatMemoryOperationProjectionSchema } from './agent/memory'
import { AgentRuntimeHintsSchema } from './agent/runtime'
import {
  AGENT_TRANSLATOR_SKILL_KEY,
  AgentTranslatorTargetLanguageSchema,
} from './agent/translator'
import { AiAvailableModelOptionSchema, AiModelRefSchema } from './ai'
import {
  CHAT_MESSAGE_ATTACHMENT_MAX_COUNT,
  CHAT_MESSAGE_ATTACHMENT_PLACEMENT_VALUES,
  CHAT_MESSAGE_ATTACHMENT_TYPE_VALUES,
  CHAT_MESSAGE_CONTENT_JSON_MAX_LENGTH,
  CHAT_MESSAGE_CONTENT_JSON_MAX_NODES,
  CHAT_MESSAGE_CONTENT_MAX_LENGTH,
  CHAT_MESSAGE_FAILURE_REASON_VALUES,
  CHAT_MESSAGE_PART_TYPE_VALUES,
  CHAT_MESSAGE_STATUS_VALUES,
  CHAT_RUN_STATUS_VALUES,
  CHAT_SESSION_CHANNEL_VALUES,
  CHAT_SESSION_EVENT_TYPE,
  CHAT_SESSION_EVENT_TYPE_VALUES,
  CHAT_SESSION_ORIGIN_VALUES,
  CHAT_SESSION_TITLE_MAX_LENGTH,
} from './chat/constants'

export {
  CHAT_MESSAGE_ATTACHMENT_MAX_COUNT,
  CHAT_MESSAGE_ATTACHMENT_PLACEMENT,
  CHAT_MESSAGE_ATTACHMENT_PLACEMENT_VALUES,
  CHAT_MESSAGE_ATTACHMENT_TYPE,
  CHAT_MESSAGE_ATTACHMENT_TYPE_VALUES,
  CHAT_MESSAGE_CONTENT_JSON_MAX_LENGTH,
  CHAT_MESSAGE_CONTENT_JSON_MAX_NODES,
  CHAT_MESSAGE_CONTENT_MAX_LENGTH,
  CHAT_MESSAGE_FAILURE_REASON,
  CHAT_MESSAGE_FAILURE_REASON_VALUES,
  CHAT_MESSAGE_PART_TYPE,
  CHAT_MESSAGE_PART_TYPE_VALUES,
  CHAT_MESSAGE_STATUS,
  CHAT_MESSAGE_STATUS_VALUES,
  CHAT_RUN_STATUS,
  CHAT_RUN_STATUS_VALUES,
  CHAT_SESSION_CHANNEL,
  CHAT_SESSION_CHANNEL_VALUES,
  CHAT_SESSION_DEFAULT_TITLE,
  CHAT_SESSION_EVENT_TYPE,
  CHAT_SESSION_EVENT_TYPE_VALUES,
  CHAT_SESSION_ORIGIN,
  CHAT_SESSION_ORIGIN_VALUES,
  CHAT_SESSION_TITLE_MAX_LENGTH,
} from './chat/constants'

export const ChatMessageRoleSchema = z.enum(['user', 'assistant'])

const IsoDateTimeStringSchema = z.string().datetime()
const NonEmptyStringSchema = z.string().trim().min(1)
const ChatSessionTitleSchema = z.string().trim().min(1).max(CHAT_SESSION_TITLE_MAX_LENGTH)
export const CHAT_CONTEXT_SNAPSHOT_MAX_CONTENT_LENGTH = 200_000
const ChatSessionSummaryBaseSchema = z.object({
  id: NonEmptyStringSchema,
  workspaceId: NonEmptyStringSchema,
  origin: z.enum(CHAT_SESSION_ORIGIN_VALUES),
  channel: z.enum(CHAT_SESSION_CHANNEL_VALUES),
  title: ChatSessionTitleSchema,
  agentProfile: z.object({
    profileId: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    description: z.string().trim().min(1).nullable(),
    avatarUrl: z.string().trim().min(1).nullable(),
  }).strict().nullable(),
  modelRef: AiModelRefSchema.pick({
    providerId: true,
    modelId: true,
  }).nullable(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

export const ChatMessageStatusSchema = z.enum(CHAT_MESSAGE_STATUS_VALUES)
export const ChatMessagePartTypeSchema = z.enum(CHAT_MESSAGE_PART_TYPE_VALUES)
export const ChatMessageFailureReasonSchema = z.enum(CHAT_MESSAGE_FAILURE_REASON_VALUES)
export const ChatRunStatusSchema = z.enum(CHAT_RUN_STATUS_VALUES)
export const ChatSessionEventTypeSchema = z.enum(CHAT_SESSION_EVENT_TYPE_VALUES)
export const ChatSessionChannelSchema = z.enum(CHAT_SESSION_CHANNEL_VALUES)
export const ChatSessionOriginSchema = z.enum(CHAT_SESSION_ORIGIN_VALUES)
export const ChatMessageAttachmentTypeSchema = z.enum(CHAT_MESSAGE_ATTACHMENT_TYPE_VALUES)
export const ChatMessageAttachmentPlacementSchema = z.enum(CHAT_MESSAGE_ATTACHMENT_PLACEMENT_VALUES)

export const ChatTranslatorSkillInvocationSchema = z.object({
  skillKey: z.literal(AGENT_TRANSLATOR_SKILL_KEY),
  targetLanguage: AgentTranslatorTargetLanguageSchema,
}).strict()

export const ChatSkillInvocationSchema = z.discriminatedUnion('skillKey', [
  ChatTranslatorSkillInvocationSchema,
  AgentDocumentAssistantSkillInvocationSchema,
])

export const ChatDisabledSkillKeysSchema = z.array(NonEmptyStringSchema)
  .max(20)
  .default([])
  .transform(skillKeys => Array.from(new Set(skillKeys)))

export const ChatMessageBranchSchema = z.object({
  index: z.number().int().positive(),
  count: z.number().int().positive(),
  previousMessageId: NonEmptyStringSchema.nullable(),
  nextMessageId: NonEmptyStringSchema.nullable(),
}).strict()

export const ChatDocumentSelectionBoundarySchema = z.object({
  blockId: NonEmptyStringSchema,
  offset: z.number().int().nonnegative(),
  position: z.number().int().nonnegative().optional().describe('发送瞬间的 ProseMirror 绝对位置，只用于本次定位展示和运行期映射，不可作为持久回放定位依据。'),
}).strict()

export const ChatDocumentScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('full'),
  }).strict(),
  z.object({
    kind: z.literal('selection'),
    field: z.literal('body'),
    blockIds: z.array(NonEmptyStringSchema).min(1),
    from: ChatDocumentSelectionBoundarySchema,
    to: ChatDocumentSelectionBoundarySchema,
  }).strict(),
])

const ChatDocumentMessageAttachmentBaseSchema = z.object({
  id: NonEmptyStringSchema,
  type: z.literal('document'),
  placement: ChatMessageAttachmentPlacementSchema,
  documentId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  scope: ChatDocumentScopeSchema,
  size: z.number().int().nonnegative(),
}).strict()

export const ChatDocumentMessageAttachmentInputSchema = ChatDocumentMessageAttachmentBaseSchema.extend({
  snapshot: z.string().max(CHAT_CONTEXT_SNAPSHOT_MAX_CONTENT_LENGTH).optional(),
}).strict()

export const ChatUploadedMessageAttachmentBaseSchema = z.object({
  id: NonEmptyStringSchema,
  type: z.enum(['image', 'file']),
  placement: z.literal('panel'),
  assetId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  fileName: NonEmptyStringSchema,
  mimeType: NonEmptyStringSchema,
  size: z.number().int().positive(),
}).strict()

export const ChatImageMessageAttachmentSchema = ChatUploadedMessageAttachmentBaseSchema.extend({
  type: z.literal('image'),
}).strict()

export const ChatFileMessageAttachmentSchema = ChatUploadedMessageAttachmentBaseSchema.extend({
  type: z.literal('file'),
}).strict()

export const ChatMessageAttachmentInputSchema = z.discriminatedUnion('type', [
  ChatDocumentMessageAttachmentInputSchema,
  ChatImageMessageAttachmentSchema,
  ChatFileMessageAttachmentSchema,
])

export const ChatPersistedMessageAttachmentSchema = z.discriminatedUnion('type', [
  ChatDocumentMessageAttachmentBaseSchema,
  ChatImageMessageAttachmentSchema,
  ChatFileMessageAttachmentSchema,
])
export const PersistedChatMessageAttachmentSchema = ChatPersistedMessageAttachmentSchema

export const ChatMessageContextSnapshotMetaSchema = z.object({
  id: NonEmptyStringSchema,
  type: z.literal('document'),
  documentId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  scope: ChatDocumentScopeSchema,
  size: z.number().int().nonnegative(),
  sourceAttachmentIds: z.array(NonEmptyStringSchema).min(1),
  capturedAt: IsoDateTimeStringSchema,
}).strict()

const ChatMessageContentTextNodeSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).strict()

const ChatMessageContentHardBreakNodeSchema = z.object({
  type: z.literal('hardBreak'),
}).strict()

export const ChatMessageContentReferenceNodeSchema = z.object({
  type: z.literal('chatReference'),
  attrs: z.object({
    id: NonEmptyStringSchema,
    attachmentId: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
  }).strict(),
}).strict()

const ChatMessageInlineContentNodeSchema = z.discriminatedUnion('type', [
  ChatMessageContentTextNodeSchema,
  ChatMessageContentHardBreakNodeSchema,
  ChatMessageContentReferenceNodeSchema,
])

const ChatMessageParagraphContentNodeSchema = z.object({
  type: z.literal('paragraph'),
  content: z.array(ChatMessageInlineContentNodeSchema).optional(),
}).strict()

export const ChatMessageContentJSONSchema = z.object({
  type: z.literal('doc'),
  content: z.array(ChatMessageParagraphContentNodeSchema).optional(),
}).strict().superRefine((value, ctx) => {
  const serialized = JSON.stringify(value)
  if (serialized.length > CHAT_MESSAGE_CONTENT_JSON_MAX_LENGTH) {
    ctx.addIssue({
      code: 'too_big',
      maximum: CHAT_MESSAGE_CONTENT_JSON_MAX_LENGTH,
      origin: 'string',
      inclusive: true,
      message: 'contentJSON is too large',
    })
  }

  const nodeCount = countContentJSONNodes(value)
  if (nodeCount > CHAT_MESSAGE_CONTENT_JSON_MAX_NODES) {
    ctx.addIssue({
      code: 'too_big',
      maximum: CHAT_MESSAGE_CONTENT_JSON_MAX_NODES,
      origin: 'array',
      inclusive: true,
      message: 'contentJSON has too many nodes',
    })
  }
})

export const ChatAssistantMessageMetadataSchema = z.object({
  failureReason: ChatMessageFailureReasonSchema.optional(),
  failureMessage: z.string().trim().min(1).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  reasoningElapsedMs: z.number().int().nonnegative().optional(),
  usage: ChatGenerationUsageSnapshotSchema.optional(),
  memoryOperations: z.array(ChatMemoryOperationProjectionSchema).optional(),
  finishReason: z.string().trim().min(1).optional(),
}).strict()

export const ChatMessageMetadataSchema = ChatAssistantMessageMetadataSchema

export const ChatUserMessageMetadataSchema = z.object({
  contentJSON: ChatMessageContentJSONSchema,
  attachments: z.array(ChatPersistedMessageAttachmentSchema).max(CHAT_MESSAGE_ATTACHMENT_MAX_COUNT),
  contextSnapshotMetas: z.array(ChatMessageContextSnapshotMetaSchema).max(CHAT_MESSAGE_ATTACHMENT_MAX_COUNT),
  memoryOperations: z.array(ChatMemoryOperationProjectionSchema).default([]),
  skillInvocation: ChatSkillInvocationSchema.nullable().optional(),
  disabledSkillKeys: ChatDisabledSkillKeysSchema,
}).strict()

export const ChatMessagePartMetadataSchema = z.object({
  elapsedMs: z.number().int().nonnegative().optional(),
  toolCallId: z.string().trim().min(1).optional(),
  skillKey: z.string().trim().min(1).optional(),
  actionName: z.string().trim().min(1).optional(),
  status: AgentToolCallStatusSchema.optional(),
  sourceId: z.string().trim().min(1).optional(),
  citationTarget: z.string().trim().min(1).optional(),
}).strict()

export const ChatMessagePartSchema = z.object({
  id: NonEmptyStringSchema,
  type: ChatMessagePartTypeSchema,
  text: z.string(),
  order: z.number().int().nonnegative(),
  metadata: ChatMessagePartMetadataSchema.nullable(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

const ChatMessageBaseSchema = z.object({
  id: NonEmptyStringSchema,
  status: ChatMessageStatusSchema,
  content: z.string(),
  branch: ChatMessageBranchSchema,
  parts: z.array(ChatMessagePartSchema),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
  completedAt: IsoDateTimeStringSchema.nullable(),
}).strict()

export const ChatUserMessageSchema = ChatMessageBaseSchema.extend({
  role: z.literal('user'),
  metadata: ChatUserMessageMetadataSchema,
}).strict()

export const ChatAssistantMessageSchema = ChatMessageBaseSchema.extend({
  role: z.literal('assistant'),
  metadata: ChatAssistantMessageMetadataSchema.nullable(),
}).strict()

export const ChatMessageSchema = z.discriminatedUnion('role', [
  ChatUserMessageSchema,
  ChatAssistantMessageSchema,
])

export const ChatTokenUsageAggregateSchema = z.object({
  generationCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict()

export const ChatSessionUsageSummarySchema = z.object({
  activePath: ChatTokenUsageAggregateSchema,
  session: ChatTokenUsageAggregateSchema,
}).strict()

export const ChatSessionSummarySchema = ChatSessionSummaryBaseSchema

export const ChatRunSummarySchema = z.object({
  runId: NonEmptyStringSchema,
  status: ChatRunStatusSchema,
  assistantMessageId: NonEmptyStringSchema,
  triggerUserMessageId: NonEmptyStringSchema,
  requiredAction: AgentClientActionSchema.nullable().default(null),
  createdAt: IsoDateTimeStringSchema,
  startedAt: IsoDateTimeStringSchema.nullable(),
  completedAt: IsoDateTimeStringSchema.nullable(),
}).strict()

export const ChatSessionDetailSchema = ChatSessionSummarySchema.extend({
  latestSequence: z.number().int().nonnegative(),
  messages: z.array(ChatMessageSchema),
  usage: ChatSessionUsageSummarySchema,
  activeRun: ChatRunSummarySchema.nullable().optional(),
}).strict()

export const ChatModelItemSchema = AiAvailableModelOptionSchema

export const ChatModelListResponseSchema = z.object({
  models: z.array(ChatModelItemSchema),
}).strict()

export const ChatRuntimeConfigSchema = z.object({
  enabled: z.boolean(),
  ready: z.boolean(),
  defaultModel: ChatModelItemSchema.nullable(),
  notReadyReason: z.string().trim().min(1).nullable(),
}).strict()

export const ChatAssetUploadQuerySchema = z.object({
  workspaceId: NonEmptyStringSchema,
}).strict()

export const ChatUploadedAssetSchema = z.object({
  id: NonEmptyStringSchema,
  type: z.enum(['image', 'file']),
  fileName: NonEmptyStringSchema,
  mimeType: NonEmptyStringSchema,
  size: z.number().int().positive(),
  createdAt: IsoDateTimeStringSchema,
}).strict()

export const CreateChatSessionRequestSchema = z.object({
  workspaceId: NonEmptyStringSchema,
  origin: ChatSessionOriginSchema.optional(),
}).strict()

export const ChatSessionOriginQuerySchema = z.object({
  origin: ChatSessionOriginSchema.optional(),
}).strict()

export const GetChatSessionsQuerySchema = ChatSessionOriginQuerySchema.extend({
  workspaceId: NonEmptyStringSchema,
}).strict()

const ChatSessionMessageRequestBaseSchema = z.object({
  content: z.string().trim().min(1).max(CHAT_MESSAGE_CONTENT_MAX_LENGTH),
  contentJSON: ChatMessageContentJSONSchema,
  attachments: z.array(ChatMessageAttachmentInputSchema).max(CHAT_MESSAGE_ATTACHMENT_MAX_COUNT).optional().nullable(),
  memory: AgentMemoryRunOptionsSchema.optional(),
  skillInvocation: ChatSkillInvocationSchema.optional().nullable(),
  disabledSkillKeys: ChatDisabledSkillKeysSchema,
  runtimeHints: AgentRuntimeHintsSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const attachmentById = new Map((value.attachments ?? []).map(attachment => [attachment.id, attachment]))

  validateDocumentAssistantContext(value, ctx)

  for (const attachmentId of collectChatReferenceAttachmentIds(value.contentJSON)) {
    const attachment = attachmentById.get(attachmentId)

    if (!attachment) {
      ctx.addIssue({
        code: 'custom',
        path: ['contentJSON'],
        message: 'chatReference attachmentId must exist in attachments',
      })
      continue
    }

    if (attachment.type !== 'document' || attachment.placement !== 'inline') {
      ctx.addIssue({
        code: 'custom',
        path: ['contentJSON'],
        message: 'chatReference can only target inline document attachments',
      })
    }
  }
})

export const CreateChatSessionMessageRequestSchema = ChatSessionMessageRequestBaseSchema

export const EditAndSendChatMessageRequestSchema = ChatSessionMessageRequestBaseSchema

export const RetryChatAssistantMessageRequestSchema = z.object({
  runtimeHints: AgentRuntimeHintsSchema.optional(),
}).strict().default({})

export const SwitchChatActiveMessageRequestSchema = z.object({
  messageId: NonEmptyStringSchema,
}).strict()

export const CancelChatRunRequestSchema = z.object({}).strict()

export const ResumeChatRunRequestSchema = z.object({
  resume: AgentClientActionResultSchema,
}).strict()

export const UpdateChatSessionModelRequestSchema = z.object({
  modelRef: AiModelRefSchema.pick({
    providerId: true,
    modelId: true,
  }).nullable(),
}).strict()

export const UpdateChatSessionTitleRequestSchema = z.object({
  title: ChatSessionTitleSchema,
}).strict()

export const BatchDeleteChatSessionsRequestSchema = z.object({
  sessionIds: z.array(NonEmptyStringSchema).min(1).max(100),
}).strict()

export const BatchDeleteChatSessionsResponseSchema = z.object({
  deletedSessionIds: z.array(NonEmptyStringSchema),
}).strict()

export const ChatMutationResponseSchema = z.object({
  session: ChatSessionDetailSchema,
  latestSequence: z.number().int().nonnegative(),
  run: ChatRunSummarySchema.optional(),
}).strict()

const ChatSessionEventBaseSchema = z.object({
  sequence: z.number().int().positive(),
  sessionId: NonEmptyStringSchema,
  messageId: NonEmptyStringSchema.nullable(),
  runId: NonEmptyStringSchema.nullable(),
  sourceEventId: NonEmptyStringSchema.nullable(),
  createdAt: IsoDateTimeStringSchema,
})

const ChatSessionEventPayloadSchema = z.record(z.string(), z.unknown())

const ChatSessionMessagePartDeltaEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA),
  messageId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  sourceEventId: NonEmptyStringSchema.nullable(),
  payload: z.object({
    partId: NonEmptyStringSchema,
    partType: ChatMessagePartTypeSchema,
    order: z.number().int().nonnegative(),
    delta: z.string(),
    metadata: ChatMessagePartMetadataSchema.nullable().optional(),
  }).strict(),
}).strict()

const ChatSessionSnapshotRequiredEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.SNAPSHOT_REQUIRED),
  messageId: z.null(),
  runId: z.null(),
  sourceEventId: z.null(),
  payload: z.object({
    reason: z.literal('cursor_expired'),
    latestSequence: z.number().int().nonnegative(),
  }).strict(),
}).strict()

const ChatSessionMessageCreatedEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.MESSAGE_CREATED),
  messageId: NonEmptyStringSchema,
  payload: ChatSessionEventPayloadSchema,
}).strict()

const ChatSessionMessageStatusChangedEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.MESSAGE_STATUS_CHANGED),
  messageId: NonEmptyStringSchema,
  payload: z.object({
    status: ChatMessageStatusSchema,
  }).strict(),
}).strict()

const ChatSessionMessageCompletedEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.MESSAGE_COMPLETED),
  messageId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  payload: ChatSessionEventPayloadSchema,
}).strict()

const ChatSessionMessageFailedEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.MESSAGE_FAILED),
  messageId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  payload: ChatSessionEventPayloadSchema,
}).strict()

const ChatSessionMessageCancelledEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.MESSAGE_CANCELLED),
  messageId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  payload: ChatSessionEventPayloadSchema,
}).strict()

const ChatSessionRunStartedEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.RUN_STARTED),
  runId: NonEmptyStringSchema,
  payload: ChatSessionEventPayloadSchema,
}).strict()

const ChatSessionRunRequiresActionEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.RUN_REQUIRES_ACTION),
  runId: NonEmptyStringSchema,
  payload: z.object({
    action: AgentClientActionSchema,
  }).strict(),
}).strict()

const ChatSessionRunCompletedEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.RUN_COMPLETED),
  runId: NonEmptyStringSchema,
  payload: ChatSessionEventPayloadSchema,
}).strict()

const ChatSessionRunFailedEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.RUN_FAILED),
  runId: NonEmptyStringSchema,
  payload: ChatSessionEventPayloadSchema,
}).strict()

const ChatSessionRunCancelledEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.RUN_CANCELLED),
  runId: NonEmptyStringSchema,
  payload: ChatSessionEventPayloadSchema,
}).strict()

const ChatSessionBranchSwitchedEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.BRANCH_SWITCHED),
  payload: ChatSessionEventPayloadSchema,
}).strict()

const ChatSessionTitleUpdatedEventSchema = ChatSessionEventBaseSchema.extend({
  type: z.literal(CHAT_SESSION_EVENT_TYPE.TITLE_UPDATED),
  payload: z.object({
    title: ChatSessionTitleSchema,
  }).strict(),
}).strict()

export const ChatSessionEventSchema = z.discriminatedUnion('type', [
  ChatSessionMessageCreatedEventSchema,
  ChatSessionMessageStatusChangedEventSchema,
  ChatSessionMessagePartDeltaEventSchema,
  ChatSessionMessageCompletedEventSchema,
  ChatSessionMessageFailedEventSchema,
  ChatSessionMessageCancelledEventSchema,
  ChatSessionRunStartedEventSchema,
  ChatSessionRunRequiresActionEventSchema,
  ChatSessionRunCompletedEventSchema,
  ChatSessionRunFailedEventSchema,
  ChatSessionRunCancelledEventSchema,
  ChatSessionBranchSwitchedEventSchema,
  ChatSessionTitleUpdatedEventSchema,
  ChatSessionSnapshotRequiredEventSchema,
])

function countContentJSONNodes(value: unknown): number {
  let count = 0
  const pending: unknown[] = [value]

  while (pending.length > 0) {
    const current = pending.pop()
    if (!isRecord(current)) {
      continue
    }

    if (typeof current.type === 'string') {
      count += 1
    }

    if (Array.isArray(current.content)) {
      pending.push(...current.content)
    }
  }

  return count
}

function validateDocumentAssistantContext(
  value: {
    attachments?: z.infer<typeof ChatMessageAttachmentInputSchema>[] | null
    skillInvocation?: z.infer<typeof ChatSkillInvocationSchema> | null
  },
  ctx: z.RefinementCtx,
) {
  if (value.skillInvocation?.skillKey !== AGENT_DOCUMENT_ASSISTANT_SKILL_KEY) {
    return
  }

  const selectionAttachments: Array<{
    attachment: z.infer<typeof ChatDocumentMessageAttachmentInputSchema> & { scope: { kind: 'selection' } }
    index: number
  }> = []

  for (const [index, attachment] of (value.attachments ?? []).entries()) {
    if (isDocumentSelectionAttachment(attachment)) {
      selectionAttachments.push({ attachment, index })
    }
  }

  if (selectionAttachments.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['attachments'],
      message: 'document assistant requires exactly one document selection attachment',
    })
    return
  }

  const selection = selectionAttachments[0]

  if (!selection) {
    return
  }

  const snapshot = selection.attachment.snapshot

  if (typeof snapshot !== 'string') {
    ctx.addIssue({
      code: 'custom',
      path: ['attachments', selection.index, 'snapshot'],
      message: 'document assistant selection attachment requires a send-time snapshot',
    })
    return
  }

  if (
    value.skillInvocation.intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.REWRITE_SELECTION
    && isCollapsedDocumentSelectionScope(selection.attachment.scope)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['attachments', selection.index, 'scope'],
      message: 'document assistant rewrite requires a non-collapsed document selection',
    })
  }

  if (
    value.skillInvocation.intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.REWRITE_SELECTION
    && !snapshot.trim()
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['attachments', selection.index, 'snapshot'],
      message: 'document assistant rewrite selection snapshot cannot be empty',
    })
  }

  if (
    value.skillInvocation.intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR
    && snapshot.length > AGENT_DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_MAX_LENGTH
  ) {
    ctx.addIssue({
      code: 'too_big',
      maximum: AGENT_DOCUMENT_ASSISTANT_ANCHOR_CONTEXT_MAX_LENGTH,
      origin: 'string',
      inclusive: true,
      path: ['attachments', selection.index, 'snapshot'],
      message: 'document assistant anchor context snapshot is too large',
    })
  }
}

function isDocumentSelectionAttachment(
  attachment: z.infer<typeof ChatMessageAttachmentInputSchema>,
): attachment is z.infer<typeof ChatDocumentMessageAttachmentInputSchema> & { scope: { kind: 'selection' } } {
  return attachment.type === 'document' && attachment.scope.kind === 'selection'
}

function isCollapsedDocumentSelectionScope(
  scope: Extract<z.infer<typeof ChatDocumentScopeSchema>, { kind: 'selection' }>,
) {
  return scope.from.blockId === scope.to.blockId
    && scope.from.offset === scope.to.offset
}

function collectChatReferenceAttachmentIds(value: unknown): string[] {
  const attachmentIds: string[] = []
  collectChatReferenceAttachmentIdsInto(value, attachmentIds)
  return attachmentIds
}

function collectChatReferenceAttachmentIdsInto(node: unknown, attachmentIds: string[]): void {
  if (!isRecord(node)) {
    return
  }

  if (node.type === 'chatReference' && isRecord(node.attrs) && typeof node.attrs.attachmentId === 'string') {
    attachmentIds.push(node.attrs.attachmentId)
  }

  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      collectChatReferenceAttachmentIdsInto(child, attachmentIds)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type ChatMessageStatus = z.infer<typeof ChatMessageStatusSchema>
export type ChatMessagePartType = z.infer<typeof ChatMessagePartTypeSchema>
export type ChatMessageFailureReason = z.infer<typeof ChatMessageFailureReasonSchema>
export type ChatRunStatus = z.infer<typeof ChatRunStatusSchema>
export type ChatSessionEventType = z.infer<typeof ChatSessionEventTypeSchema>
export type ChatSessionChannel = z.infer<typeof ChatSessionChannelSchema>
export type ChatSessionOrigin = z.infer<typeof ChatSessionOriginSchema>
export type ChatMessageAttachmentType = z.infer<typeof ChatMessageAttachmentTypeSchema>
export type ChatMessageAttachmentPlacement = z.infer<typeof ChatMessageAttachmentPlacementSchema>
export type ChatTranslatorSkillInvocation = z.infer<typeof ChatTranslatorSkillInvocationSchema>
export type ChatSkillInvocation = z.infer<typeof ChatSkillInvocationSchema>
export type ChatDisabledSkillKeys = z.infer<typeof ChatDisabledSkillKeysSchema>
export type ChatDocumentSelectionBoundary = z.infer<typeof ChatDocumentSelectionBoundarySchema>
export type ChatDocumentScope = z.infer<typeof ChatDocumentScopeSchema>
export type ChatDocumentMessageAttachmentInput = z.infer<typeof ChatDocumentMessageAttachmentInputSchema>
export type ChatUploadedMessageAttachment = z.infer<typeof ChatUploadedMessageAttachmentBaseSchema>
export type ChatImageMessageAttachment = z.infer<typeof ChatImageMessageAttachmentSchema>
export type ChatFileMessageAttachment = z.infer<typeof ChatFileMessageAttachmentSchema>
export type ChatMessageAttachmentInput = z.infer<typeof ChatMessageAttachmentInputSchema>
export type ChatPersistedMessageAttachment = z.infer<typeof ChatPersistedMessageAttachmentSchema>
export type PersistedChatMessageAttachment = z.infer<typeof PersistedChatMessageAttachmentSchema>
export type ChatMessageContextSnapshotMeta = z.infer<typeof ChatMessageContextSnapshotMetaSchema>
export type ChatMessageContentReferenceNode = z.infer<typeof ChatMessageContentReferenceNodeSchema>
export type ChatMessageContentJSON = z.infer<typeof ChatMessageContentJSONSchema>
export type ChatMessageBranch = z.infer<typeof ChatMessageBranchSchema>
export type ChatMessageMetadata = z.infer<typeof ChatMessageMetadataSchema>
export type ChatAssistantMessageMetadata = z.infer<typeof ChatAssistantMessageMetadataSchema>
export type ChatUserMessageMetadata = z.infer<typeof ChatUserMessageMetadataSchema>
export type ChatTokenUsageAggregate = z.infer<typeof ChatTokenUsageAggregateSchema>
export type ChatSessionUsageSummary = z.infer<typeof ChatSessionUsageSummarySchema>
export type ChatMessagePartMetadata = z.infer<typeof ChatMessagePartMetadataSchema>
export type ChatMessagePart = z.infer<typeof ChatMessagePartSchema>
export type ChatUserMessage = z.infer<typeof ChatUserMessageSchema>
export type ChatAssistantMessage = z.infer<typeof ChatAssistantMessageSchema>
export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type ChatSessionSummary = z.infer<typeof ChatSessionSummarySchema>
export type ChatSessionDetail = z.infer<typeof ChatSessionDetailSchema>
export type ChatModelItem = z.infer<typeof ChatModelItemSchema>
export type ChatModelListResponse = z.infer<typeof ChatModelListResponseSchema>
export type ChatRuntimeConfig = z.infer<typeof ChatRuntimeConfigSchema>
export type ChatAssetUploadQuery = z.infer<typeof ChatAssetUploadQuerySchema>
export type ChatUploadedAsset = z.infer<typeof ChatUploadedAssetSchema>
export type ChatRunSummary = z.infer<typeof ChatRunSummarySchema>
export type CreateChatSessionRequest = z.infer<typeof CreateChatSessionRequestSchema>
export type ChatSessionOriginQuery = z.infer<typeof ChatSessionOriginQuerySchema>
export type GetChatSessionsQuery = z.infer<typeof GetChatSessionsQuerySchema>
export type CreateChatSessionMessageRequest = z.infer<typeof CreateChatSessionMessageRequestSchema>
export type EditAndSendChatMessageRequest = z.infer<typeof EditAndSendChatMessageRequestSchema>
export type RetryChatAssistantMessageRequest = z.infer<typeof RetryChatAssistantMessageRequestSchema>
export type SwitchChatActiveMessageRequest = z.infer<typeof SwitchChatActiveMessageRequestSchema>
export type CancelChatRunRequest = z.infer<typeof CancelChatRunRequestSchema>
export type ResumeChatRunRequest = z.infer<typeof ResumeChatRunRequestSchema>
export type ChatMutationResponse = z.infer<typeof ChatMutationResponseSchema>
export type UpdateChatSessionModelRequest = z.infer<typeof UpdateChatSessionModelRequestSchema>
export type UpdateChatSessionTitleRequest = z.infer<typeof UpdateChatSessionTitleRequestSchema>
export type BatchDeleteChatSessionsRequest = z.infer<typeof BatchDeleteChatSessionsRequestSchema>
export type BatchDeleteChatSessionsResponse = z.infer<typeof BatchDeleteChatSessionsResponseSchema>
export type ChatModelSelection = UpdateChatSessionModelRequest
export type ChatSessionEvent = z.infer<typeof ChatSessionEventSchema>
