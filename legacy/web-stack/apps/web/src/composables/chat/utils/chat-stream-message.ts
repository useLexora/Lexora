import type { ChatMessage, ChatMessageMetadata, ChatSessionEvent } from '@/apis/chat'
import {
  CHAT_MESSAGE_FAILURE_REASON,
  CHAT_MESSAGE_PART_TYPE,
  CHAT_MESSAGE_STATUS,
  CHAT_SESSION_EVENT_TYPE,
} from '@haohaoxue/lexora-contracts/chat/constants'
import { translate } from '@/i18n'
import dayjs from '@/utils/dayjs'

type ChatMessagePart = ChatMessage['parts'][number]
type AssistantChatMessage = Extract<ChatMessage, { role: 'assistant' }>

export function applyChatSessionEventToMessages(
  messages: ChatMessage[],
  event: ChatSessionEvent,
): ChatMessage[] {
  switch (event.type) {
    case CHAT_SESSION_EVENT_TYPE.MESSAGE_PART_DELTA:
      return appendMessagePartDelta(messages, event.messageId, {
        partId: event.payload.partId,
        partType: event.payload.partType,
        order: event.payload.order,
        delta: event.payload.delta,
        metadata: event.payload.metadata ?? null,
      })
    case CHAT_SESSION_EVENT_TYPE.MESSAGE_STATUS_CHANGED:
      return updateMessageStatus(messages, event.messageId, event.payload.status)
    case CHAT_SESSION_EVENT_TYPE.MESSAGE_COMPLETED:
      return completeMessage(
        messages,
        event.messageId,
        getPayloadString(event.payload, 'content') ?? '',
        getPayloadMetadata(event.payload),
      )
    case CHAT_SESSION_EVENT_TYPE.MESSAGE_FAILED:
      return failMessage(
        messages,
        event.messageId,
        getPayloadString(event.payload, 'failureMessage') ?? getPayloadString(event.payload, 'message') ?? translate('chat.errors.generationFailed'),
      )
    case CHAT_SESSION_EVENT_TYPE.MESSAGE_CANCELLED:
      return updateMessageStatus(messages, event.messageId, CHAT_MESSAGE_STATUS.CANCELLED, {
        completedAt: dayjs().toISOString(),
      })
    case CHAT_SESSION_EVENT_TYPE.MESSAGE_CREATED:
    case CHAT_SESSION_EVENT_TYPE.RUN_STARTED:
    case CHAT_SESSION_EVENT_TYPE.RUN_REQUIRES_ACTION:
    case CHAT_SESSION_EVENT_TYPE.RUN_COMPLETED:
    case CHAT_SESSION_EVENT_TYPE.RUN_FAILED:
    case CHAT_SESSION_EVENT_TYPE.RUN_CANCELLED:
    case CHAT_SESSION_EVENT_TYPE.BRANCH_SWITCHED:
    case CHAT_SESSION_EVENT_TYPE.TITLE_UPDATED:
    case CHAT_SESSION_EVENT_TYPE.SNAPSHOT_REQUIRED:
      return messages
  }
}

function appendMessagePartDelta(
  messages: ChatMessage[],
  messageId: string,
  input: {
    partId: string
    partType: ChatMessagePart['type']
    order: number
    delta: string
    metadata: ChatMessagePart['metadata']
  },
): ChatMessage[] {
  if (!input.delta && !input.metadata) {
    return messages
  }

  const index = messages.findIndex(message => message.id === messageId)
  if (index < 0) {
    return messages
  }

  const now = dayjs().toISOString()
  const message = messages[index]
  const parts = upsertPart(message, input, now)
  const content = input.partType === CHAT_MESSAGE_PART_TYPE.TEXT
    ? getPartText(parts, CHAT_MESSAGE_PART_TYPE.TEXT)
    : message.content

  return updateMessage(messages, index, {
    ...message,
    status: message.status === CHAT_MESSAGE_STATUS.COMPLETED
      ? message.status
      : CHAT_MESSAGE_STATUS.STREAMING,
    content,
    parts,
    updatedAt: now,
  })
}

function updateMessageStatus(
  messages: ChatMessage[],
  messageId: string,
  status: ChatMessage['status'],
  patch: Partial<Pick<ChatMessage, 'completedAt'>> = {},
): ChatMessage[] {
  const index = messages.findIndex(message => message.id === messageId)
  if (index < 0) {
    return messages
  }

  return updateMessage(messages, index, {
    ...messages[index],
    status,
    updatedAt: dayjs().toISOString(),
    ...patch,
  })
}

function completeMessage(
  messages: ChatMessage[],
  messageId: string,
  content: string,
  metadata: ChatMessageMetadata | null,
): ChatMessage[] {
  const index = messages.findIndex(message => message.id === messageId)
  if (index < 0) {
    return messages
  }

  const now = dayjs().toISOString()
  const message = messages[index]
  const assistantMessage = toAssistantChatMessage(message)
  const parts = content
    ? replaceTextPart(message, content, now)
    : message.parts

  if (!assistantMessage) {
    return messages
  }

  return updateMessage(messages, index, {
    ...assistantMessage,
    status: CHAT_MESSAGE_STATUS.COMPLETED,
    content,
    parts,
    metadata: metadata
      ? { ...(assistantMessage.metadata ?? {}), ...metadata }
      : assistantMessage.metadata,
    updatedAt: now,
    completedAt: now,
  })
}

function failMessage(
  messages: ChatMessage[],
  messageId: string,
  failureMessage: string,
): ChatMessage[] {
  const index = messages.findIndex(message => message.id === messageId)
  if (index < 0) {
    return messages
  }

  const now = dayjs().toISOString()
  const message = messages[index]
  const assistantMessage = toAssistantChatMessage(message)
  if (!assistantMessage) {
    return messages
  }

  return updateMessage(messages, index, {
    ...assistantMessage,
    status: CHAT_MESSAGE_STATUS.FAILED,
    metadata: {
      ...(assistantMessage.metadata ?? {}),
      failureReason: CHAT_MESSAGE_FAILURE_REASON.FAILED,
      failureMessage,
    },
    updatedAt: now,
    completedAt: now,
  })
}

function upsertPart(
  message: ChatMessage,
  input: {
    partId: string
    partType: ChatMessagePart['type']
    order: number
    delta: string
    metadata: ChatMessagePart['metadata']
  },
  now: string,
): ChatMessagePart[] {
  const parts = [...message.parts]
  const index = parts.findIndex(part => part.id === input.partId)

  if (index >= 0) {
    const part = parts[index]
    parts[index] = {
      ...part,
      text: part.text + input.delta,
      metadata: input.metadata,
      updatedAt: now,
    }
    return sortParts(parts)
  }

  return sortParts([
    ...parts,
    createTransientPart({
      id: input.partId,
      type: input.partType,
      text: input.delta,
      order: input.order,
      metadata: input.metadata,
      now,
    }),
  ])
}

function replaceTextPart(
  message: ChatMessage,
  content: string,
  now: string,
): ChatMessagePart[] {
  const parts = [...message.parts]
  const index = parts.findIndex(part => part.type === CHAT_MESSAGE_PART_TYPE.TEXT)

  if (index >= 0) {
    const part = parts[index]
    parts[index] = {
      ...part,
      text: content,
      updatedAt: now,
    }
    return sortParts(parts)
  }

  return sortParts([
    ...parts,
    createTransientPart({
      id: `${message.id}:${CHAT_MESSAGE_PART_TYPE.TEXT}`,
      type: CHAT_MESSAGE_PART_TYPE.TEXT,
      text: content,
      order: getPartOrder(CHAT_MESSAGE_PART_TYPE.TEXT),
      metadata: null,
      now,
    }),
  ])
}

function createTransientPart(input: {
  id: string
  type: ChatMessagePart['type']
  text: string
  order: number
  metadata: ChatMessagePart['metadata']
  now: string
}): ChatMessagePart {
  return {
    id: input.id,
    type: input.type,
    text: input.text,
    order: input.order,
    metadata: input.metadata,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

function getPartText(parts: ChatMessagePart[], partType: ChatMessagePart['type']) {
  return parts.find(part => part.type === partType)?.text ?? ''
}

function getPartOrder(partType: ChatMessagePart['type']) {
  if (partType === CHAT_MESSAGE_PART_TYPE.REASONING) {
    return 0
  }

  if (partType === CHAT_MESSAGE_PART_TYPE.TEXT) {
    return 1
  }

  return 10
}

function sortParts(parts: ChatMessagePart[]) {
  return [...parts].sort((first, second) => first.order - second.order)
}

function updateMessage(messages: ChatMessage[], index: number, nextMessage: ChatMessage) {
  const nextMessages = [...messages]
  nextMessages[index] = nextMessage
  return nextMessages
}

function toAssistantChatMessage(message: ChatMessage): AssistantChatMessage | null {
  return message.role === 'assistant' ? message as AssistantChatMessage : null
}

function getPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function getPayloadMetadata(payload: Record<string, unknown>): ChatMessageMetadata | null {
  const metadata = payload.metadata
  return metadata && typeof metadata === 'object'
    ? metadata as ChatMessageMetadata
    : null
}
