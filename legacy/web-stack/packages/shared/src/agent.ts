import { AGENT_CHAT_THREAD_PREFIX } from '@haohaoxue/lexora-contracts/agent/chat'

const AGENT_INTERNAL_TOOL_PROTOCOL_LOOKBEHIND_LENGTH = 64
const AGENT_INTERNAL_TOOL_PROTOCOL_OPEN_PATTERN = /<\s*(?:[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]\s*)?tool_calls\s*>/i
const AGENT_INTERNAL_TOOL_PROTOCOL_CLOSE_PATTERN = /<\s*\/\s*(?:[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]\s*)?tool_calls\s*>/i

export function buildAgentChatThreadId(sessionId: string): string {
  return `${AGENT_CHAT_THREAD_PREFIX}${sessionId}`
}

export function createAgentInternalToolProtocolStripper() {
  let buffer = ''
  let isInsideToolCallBlock = false

  function drain(isFinal: boolean) {
    const result = {
      textDeltas: [] as string[],
      suppressedBlockCount: 0,
    }

    while (buffer.length > 0) {
      if (!isInsideToolCallBlock) {
        const openTag = findPattern(buffer, AGENT_INTERNAL_TOOL_PROTOCOL_OPEN_PATTERN)

        if (!openTag) {
          const flushLength = isFinal
            ? buffer.length
            : getTextFlushLengthWithoutAgentInternalToolProtocolOpenTag(buffer)

          if (flushLength > 0) {
            result.textDeltas.push(buffer.slice(0, flushLength))
            buffer = buffer.slice(flushLength)
          }
          break
        }

        if (openTag.index > 0) {
          result.textDeltas.push(buffer.slice(0, openTag.index))
          buffer = buffer.slice(openTag.index)
        }

        isInsideToolCallBlock = true
      }

      const closeTag = findPattern(buffer, AGENT_INTERNAL_TOOL_PROTOCOL_CLOSE_PATTERN)
      if (!closeTag) {
        if (isFinal) {
          result.suppressedBlockCount += 1
          buffer = ''
          isInsideToolCallBlock = false
        }
        break
      }

      result.suppressedBlockCount += 1
      buffer = buffer.slice(closeTag.index + closeTag.text.length)
      isInsideToolCallBlock = false
    }

    return result
  }

  return {
    write(text: string) {
      buffer += text
      return drain(false)
    },
    flush() {
      return drain(true)
    },
  }
}

function findPattern(input: string, pattern: RegExp): { index: number, text: string } | null {
  const match = pattern.exec(input)
  return match
    ? {
        index: match.index,
        text: match[0],
      }
    : null
}

function getTextFlushLengthWithoutAgentInternalToolProtocolOpenTag(input: string): number {
  const possibleOpenTagStart = input.lastIndexOf('<')
  if (possibleOpenTagStart < 0) {
    return input.length
  }

  const suffix = input.slice(possibleOpenTagStart)
  return suffix.length <= AGENT_INTERNAL_TOOL_PROTOCOL_LOOKBEHIND_LENGTH
    ? possibleOpenTagStart
    : input.length
}
