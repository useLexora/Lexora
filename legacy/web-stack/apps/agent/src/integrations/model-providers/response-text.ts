import type { AgentChatModelResponse } from './chat-model'

export function readChatModelResponseText(response: AgentChatModelResponse): string {
  return readVisibleContentText(response.content)
}

export function readChatModelResponseReasoning(response: AgentChatModelResponse): string {
  const responseRecord = response as unknown as Record<string, unknown>
  const chunks = [
    readReasoningFromRecord(responseRecord),
  ]

  if (isRecord(response)) {
    chunks.push(readReasoningFromUnknown(responseRecord.reasoning_details))
    chunks.push(readReasoningFromUnknown(responseRecord.thinking_blocks))
    chunks.push(readReasoningFromUnknown(response.contentBlocks))
    chunks.push(readReasoningFromUnknown(response.content_blocks))
    chunks.push(readReasoningFromUnknown(response.additional_kwargs))
    chunks.push(readReasoningFromUnknown(response.response_metadata))
  }

  chunks.push(readReasoningFromUnknown(response.content))

  return dedupeTextChunks(chunks).join('')
}

function readVisibleContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content.map(readContentBlockText).join('')
}

function readReasoningFromUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return ''
  }

  if (Array.isArray(value)) {
    return value.map(readReasoningFromUnknown).join('')
  }

  if (!isRecord(value)) {
    return ''
  }

  return [
    readReasoningFromRecord(value),
    isReasoningBlock(value) ? readTextLikeValue(value) : '',
    readReasoningFromUnknown(value.reasoning_details),
    readReasoningFromUnknown(value.thinking_blocks),
  ].join('')
}

function readContentBlockText(block: unknown): string {
  if (typeof block === 'string') {
    return block
  }
  if (!isRecord(block)) {
    return ''
  }

  if (isReasoningBlock(block)) {
    return ''
  }

  const text = block.text
  return typeof text === 'string' ? text : ''
}

function readReasoningFromRecord(record: Record<string, unknown>): string {
  const chunks = [
    readStringField(record.reasoning),
    readStringField(record.reasoning_content),
    readStringField(record.thinking),
  ]

  return dedupeTextChunks(chunks).join('')
}

function readTextLikeValue(record: Record<string, unknown>): string {
  const text = readStringField(record.text)
  if (text) {
    return text
  }

  const content = record.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content.map(readVisibleContentText).join('')
  }

  const delta = readStringField(record.delta)
  return delta
}

function readStringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function dedupeTextChunks(chunks: string[]): string[] {
  const seen = new Set<string>()
  return chunks.filter((chunk) => {
    if (!chunk || seen.has(chunk)) {
      return false
    }

    seen.add(chunk)
    return true
  })
}

function isReasoningBlock(block: Record<string, unknown>): boolean {
  const blockType = block.type
  if (typeof blockType !== 'string') {
    return false
  }

  const normalizedType = blockType.toLowerCase()
  return normalizedType.includes('reasoning') || normalizedType.includes('thinking')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
