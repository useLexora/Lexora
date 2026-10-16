import type {
  AiModelRef,
  ChatMessage,
  ChatMessageBranch,
  ChatMessageContentJSON,
  ChatMessageContextSnapshotMeta,
  ChatMessageMetadata,
  ChatMessagePart,
  ChatMessagePartMetadata,
  ChatMessagePartType,
  ChatMessageStatus,
  ChatPersistedMessageAttachment,
  ChatRunSummary,
  ChatSessionDetail,
  ChatSessionSummary,
  ChatSessionUsageSummary,
  ChatUserMessageMetadata,
  ChatSessionChannel as ContractChatSessionChannel,
  ChatSessionOrigin as ContractChatSessionOrigin,
} from '@haohaoxue/lexora-contracts'
import {
  CHAT_MESSAGE_ATTACHMENT_TYPE,
  CHAT_MESSAGE_PART_TYPE,
  CHAT_MESSAGE_STATUS,
  CHAT_SESSION_CHANNEL,
  CHAT_SESSION_ORIGIN,
  ChatDisabledSkillKeysSchema,
  ChatGenerationUsageSnapshotSchema,
  ChatMemoryOperationProjectionSchema,
  ChatSkillInvocationSchema,
} from '@haohaoxue/lexora-contracts'
import {
  ChatSessionMessageRole,
  ChatSessionChannel as PrismaChatSessionChannel,
  ChatSessionMessagePartType as PrismaChatSessionMessagePartType,
  ChatSessionMessageStatus as PrismaChatSessionMessageStatus,
  ChatSessionOrigin as PrismaChatSessionOrigin,
} from '@prisma/client'

export interface ChatSessionSummaryRecord {
  id: string
  workspaceId: string
  origin: PrismaChatSessionOrigin
  channel: PrismaChatSessionChannel
  title: string
  selectedProviderId: string | null
  selectedModelId: string | null
  agentProfile: {
    id: string
    name: string
    description: string | null
    avatarUrl: string | null
  } | null
  modelOverrideProviderId: string | null
  modelOverrideModelId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ChatSessionMessageRecord {
  id: string
  role: ChatSessionMessageRole
  status: PrismaChatSessionMessageStatus
  content: string
  branch: ChatMessageBranch
  parts: ChatSessionMessagePartRecord[]
  contextSnapshots: ChatMessageContextSnapshotRecord[]
  metadata: unknown
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

export interface ChatSessionMessagePartRecord {
  id: string
  type: PrismaChatSessionMessagePartType
  text: string
  order: number
  metadata: unknown
  createdAt: Date
  updatedAt: Date
}

export interface ChatMessageContextSnapshotRecord {
  id: string
  type: string
  documentId: string
  title: string
  scope: unknown
  size: number
  sourceAttachmentIds: unknown
  content?: string
  capturedAt: Date
}

export interface ChatSessionDetailRecord extends ChatSessionSummaryRecord {
  activeRun?: ChatRunSummary | null
  latestSequence: number
  messages: ChatSessionMessageRecord[]
  allMessages?: ChatSessionMessageRecord[]
}

export function toChatSessionSummary(session: ChatSessionSummaryRecord): ChatSessionSummary {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    origin: toChatSessionOrigin(session.origin),
    channel: toChatSessionChannel(session.channel),
    title: session.title,
    agentProfile: session.agentProfile
      ? {
          profileId: session.agentProfile.id,
          name: session.agentProfile.name,
          description: session.agentProfile.description,
          avatarUrl: session.agentProfile.avatarUrl,
        }
      : null,
    modelRef: toChatSessionModelRef(session),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  }
}

export function toChatSessionDetail(session: ChatSessionDetailRecord): ChatSessionDetail {
  const detail: ChatSessionDetail = {
    ...toChatSessionSummary(session),
    latestSequence: session.latestSequence,
    messages: session.messages.map(toChatMessage),
    usage: {
      activePath: aggregateChatTokenUsage(session.messages),
      session: aggregateChatTokenUsage(session.allMessages ?? session.messages),
    },
  }

  if (session.activeRun) {
    detail.activeRun = session.activeRun
  }

  return detail
}

function aggregateChatTokenUsage(messages: ChatSessionMessageRecord[]): ChatSessionUsageSummary['activePath'] {
  return messages.reduce<ChatSessionUsageSummary['activePath']>((total, message) => {
    if (message.role !== ChatSessionMessageRole.ASSISTANT) {
      return total
    }

    const usage = toChatMessageMetadata(message.metadata)?.usage
    if (!usage) {
      return total
    }

    return {
      generationCount: total.generationCount + 1,
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
    }
  }, {
    generationCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  })
}

export function getChatMessageContentSnapshot(
  message: Pick<ChatSessionMessageRecord, 'content' | 'parts'>,
): string {
  return message.parts.find(part => part.type === PrismaChatSessionMessagePartType.TEXT)?.text ?? message.content
}

export function toChatMessageRole(role: ChatSessionMessageRole): ChatMessage['role'] {
  return role === ChatSessionMessageRole.USER ? 'user' : 'assistant'
}

export function toChatSessionOrigin(origin: PrismaChatSessionOrigin): ChatSessionSummary['origin'] {
  return origin === PrismaChatSessionOrigin.DOCS ? CHAT_SESSION_ORIGIN.DOCS : CHAT_SESSION_ORIGIN.GLOBAL
}

export function toPrismaChatSessionOrigin(origin: ContractChatSessionOrigin): PrismaChatSessionOrigin {
  return origin === CHAT_SESSION_ORIGIN.DOCS ? PrismaChatSessionOrigin.DOCS : PrismaChatSessionOrigin.GLOBAL
}

export function toChatSessionChannel(channel: PrismaChatSessionChannel): ChatSessionSummary['channel'] {
  return channel === PrismaChatSessionChannel.WEIXIN_BOT ? CHAT_SESSION_CHANNEL.WEIXIN_BOT : CHAT_SESSION_CHANNEL.DIRECT
}

export function toPrismaChatSessionChannel(channel: ContractChatSessionChannel): PrismaChatSessionChannel {
  return channel === CHAT_SESSION_CHANNEL.WEIXIN_BOT ? PrismaChatSessionChannel.WEIXIN_BOT : PrismaChatSessionChannel.DIRECT
}

export function toChatMessageStatus(status: PrismaChatSessionMessageStatus): ChatMessageStatus {
  if (status === PrismaChatSessionMessageStatus.PENDING) {
    return CHAT_MESSAGE_STATUS.PENDING
  }
  if (status === PrismaChatSessionMessageStatus.STREAMING) {
    return CHAT_MESSAGE_STATUS.STREAMING
  }
  if (status === PrismaChatSessionMessageStatus.FAILED) {
    return CHAT_MESSAGE_STATUS.FAILED
  }
  if (status === PrismaChatSessionMessageStatus.CANCELLED) {
    return CHAT_MESSAGE_STATUS.CANCELLED
  }

  return CHAT_MESSAGE_STATUS.COMPLETED
}

export function toPrismaChatMessagePartType(type: ChatMessagePartType): PrismaChatSessionMessagePartType {
  if (type === CHAT_MESSAGE_PART_TYPE.REASONING) {
    return PrismaChatSessionMessagePartType.REASONING
  }
  if (type === CHAT_MESSAGE_PART_TYPE.TOOL_CALL) {
    return PrismaChatSessionMessagePartType.TOOL_CALL
  }
  if (type === CHAT_MESSAGE_PART_TYPE.TOOL_RESULT) {
    return PrismaChatSessionMessagePartType.TOOL_RESULT
  }
  if (type === CHAT_MESSAGE_PART_TYPE.SOURCE) {
    return PrismaChatSessionMessagePartType.SOURCE
  }
  if (type === CHAT_MESSAGE_PART_TYPE.CITATION) {
    return PrismaChatSessionMessagePartType.CITATION
  }

  return PrismaChatSessionMessagePartType.TEXT
}

function toChatMessagePart(part: ChatSessionMessagePartRecord): ChatMessagePart {
  return {
    id: part.id,
    type: toChatMessagePartType(part.type),
    text: part.text,
    order: part.order,
    metadata: toChatMessagePartMetadata(part.metadata),
    createdAt: part.createdAt.toISOString(),
    updatedAt: part.updatedAt.toISOString(),
  }
}

function toChatMessagePartType(type: PrismaChatSessionMessagePartType): ChatMessagePartType {
  if (type === PrismaChatSessionMessagePartType.REASONING) {
    return CHAT_MESSAGE_PART_TYPE.REASONING
  }
  if (type === PrismaChatSessionMessagePartType.TOOL_CALL) {
    return CHAT_MESSAGE_PART_TYPE.TOOL_CALL
  }
  if (type === PrismaChatSessionMessagePartType.TOOL_RESULT) {
    return CHAT_MESSAGE_PART_TYPE.TOOL_RESULT
  }
  if (type === PrismaChatSessionMessagePartType.SOURCE) {
    return CHAT_MESSAGE_PART_TYPE.SOURCE
  }
  if (type === PrismaChatSessionMessagePartType.CITATION) {
    return CHAT_MESSAGE_PART_TYPE.CITATION
  }

  return CHAT_MESSAGE_PART_TYPE.TEXT
}

function toChatMessage(message: ChatSessionMessageRecord): ChatMessage {
  const common = {
    id: message.id,
    status: toChatMessageStatus(message.status),
    content: getChatMessageContentSnapshot(message),
    branch: message.branch,
    parts: message.parts.map(toChatMessagePart),
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
    completedAt: message.completedAt?.toISOString() ?? null,
  }

  if (message.role === ChatSessionMessageRole.USER) {
    return {
      ...common,
      role: 'user',
      metadata: toChatUserMessageMetadata(message),
    }
  }

  return {
    ...common,
    role: 'assistant',
    metadata: toChatMessageMetadata(message.metadata),
  }
}

function toChatMessageMetadata(metadata: unknown): ChatMessageMetadata | null {
  if (!isRecord(metadata)) {
    return null
  }

  const usageResult = ChatGenerationUsageSnapshotSchema.safeParse(metadata.usage)
  const normalized = { ...metadata }
  if (usageResult.success) {
    normalized.usage = usageResult.data
  }
  else {
    delete normalized.usage
  }

  return normalized as ChatMessageMetadata
}

export function toChatUserMessageMetadata(message: ChatSessionMessageRecord): ChatUserMessageMetadata {
  const metadata = isRecord(message.metadata) ? message.metadata : {}
  const contentJSON = isRecord(metadata.contentJSON)
    ? metadata.contentJSON as ChatMessageContentJSON
    : toPlainTextContentJSON(message.content)
  const attachments = Array.isArray(metadata.attachments)
    ? metadata.attachments as ChatPersistedMessageAttachment[]
    : []
  const skillInvocationResult = ChatSkillInvocationSchema.safeParse(metadata.skillInvocation)
  const memoryOperations = Array.isArray(metadata.memoryOperations)
    ? metadata.memoryOperations.map(operation => ChatMemoryOperationProjectionSchema.safeParse(operation))
        .filter(result => result.success)
        .map(result => result.data)
    : []

  return {
    contentJSON,
    attachments,
    contextSnapshotMetas: message.contextSnapshots.map(toChatMessageContextSnapshotMeta),
    memoryOperations,
    skillInvocation: skillInvocationResult.success ? skillInvocationResult.data : null,
    disabledSkillKeys: ChatDisabledSkillKeysSchema.parse(metadata.disabledSkillKeys),
  }
}

export function toChatMessageContextSnapshotMeta(
  snapshot: ChatMessageContextSnapshotRecord,
): ChatMessageContextSnapshotMeta {
  return {
    id: snapshot.id,
    type: CHAT_MESSAGE_ATTACHMENT_TYPE.DOCUMENT,
    documentId: snapshot.documentId,
    title: snapshot.title,
    scope: snapshot.scope as ChatMessageContextSnapshotMeta['scope'],
    size: snapshot.size,
    sourceAttachmentIds: toStringArray(snapshot.sourceAttachmentIds),
    capturedAt: snapshot.capturedAt.toISOString(),
  }
}

function toChatMessagePartMetadata(metadata: unknown): ChatMessagePartMetadata | null {
  return isRecord(metadata) ? metadata as ChatMessagePartMetadata : null
}

export function toChatSessionModelRef(
  session: Pick<ChatSessionSummaryRecord, 'modelOverrideProviderId' | 'modelOverrideModelId'>,
): Pick<AiModelRef, 'providerId' | 'modelId'> | null {
  if (!session.modelOverrideProviderId || !session.modelOverrideModelId) {
    return null
  }

  return {
    providerId: session.modelOverrideProviderId,
    modelId: session.modelOverrideModelId,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function toPlainTextContentJSON(content: string): ChatMessageContentJSON {
  return {
    type: 'doc',
    content: content.split('\n').map((line) => {
      if (!line) {
        return { type: 'paragraph' }
      }

      return {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: line,
          },
        ],
      }
    }),
  }
}
