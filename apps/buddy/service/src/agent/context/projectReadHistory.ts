import type { ToolResultMessage } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { isHistoricalBinaryRead, READ_CONTENT_NOTICE } from '../files/readFileContent'

export function projectReadResult(
  message: ToolResultMessage,
  options?: { omitImages?: boolean },
): ToolResultMessage {
  if (message.toolName !== 'read' || message.isError)
    return message
  const hasBinaryText = message.content.some(block => block.type === 'text' && isHistoricalBinaryRead(block.text))
  const hasImage = options?.omitImages && message.content.some(block => block.type === 'image')
  if (!hasBinaryText && !hasImage)
    return message

  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type === 'text' && isHistoricalBinaryRead(block.text))
        return { type: 'text', text: `Earlier raw file output was omitted from this request. ${READ_CONTENT_NOTICE}` }
      if (options?.omitImages && block.type === 'image')
        return { type: 'text', text: 'Earlier image file output was omitted from session history compaction. Read the file again if visual inspection is needed.' }
      return block
    }),
    details: undefined,
  }
}

export function projectReadHistory(
  messages: readonly AgentSession['messages'][number][],
  options?: { omitImages?: boolean },
): AgentSession['messages'] {
  return messages.map(message => message.role === 'toolResult' ? projectReadResult(message, options) : message)
}
