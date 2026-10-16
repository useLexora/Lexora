import type {
  AgentChatContextMessage,
  AgentChatRuntimeContext,
} from '@haohaoxue/lexora-contracts'
import type { AgentHistoryDigest } from '../context/history-compaction'
import type { AgentCheckpointState } from './state'

export interface AgentGraphInput {
  sessionId: string
  sessionHistoryVersion: number
  activePathKey: string
  activePathTailMessageId: string
  olderMessagesExcerpt: string
  historyDigest: AgentHistoryDigest | null
  messages: AgentChatContextMessage[]
}

export interface AgentGraphInputDecision {
  mode: 'cold-start' | 'continue' | 'direct-invocation'
  shouldResetCheckpoint: boolean
  graphInput: AgentGraphInput
}

export function resolveAgentGraphInput(
  runtimeContext: AgentChatRuntimeContext,
  checkpointState: AgentCheckpointState | null,
  options: { directInvocation?: boolean } = {},
): AgentGraphInputDecision {
  const triggerUserMessage = readTriggerUserMessage(runtimeContext)

  if (options.directInvocation) {
    return {
      mode: 'direct-invocation',
      shouldResetCheckpoint: false,
      graphInput: {
        sessionId: runtimeContext.sessionId,
        sessionHistoryVersion: runtimeContext.sessionHistoryVersion,
        activePathKey: runtimeContext.activePathKey,
        activePathTailMessageId: runtimeContext.assistantMessageId,
        olderMessagesExcerpt: '',
        historyDigest: null,
        messages: [triggerUserMessage],
      },
    }
  }

  const compatible = isAgentCheckpointCompatible(runtimeContext, checkpointState)

  return {
    mode: compatible ? 'continue' : 'cold-start',
    shouldResetCheckpoint: Boolean(checkpointState && !compatible),
    graphInput: {
      sessionId: runtimeContext.sessionId,
      sessionHistoryVersion: runtimeContext.sessionHistoryVersion,
      activePathKey: runtimeContext.activePathKey,
      activePathTailMessageId: runtimeContext.assistantMessageId,
      olderMessagesExcerpt: compatible ? checkpointState?.olderMessagesExcerpt ?? '' : '',
      historyDigest: compatible ? checkpointState?.historyDigest ?? null : null,
      messages: compatible ? [triggerUserMessage] : runtimeContext.messages,
    },
  }
}

function isAgentCheckpointCompatible(
  runtimeContext: AgentChatRuntimeContext,
  checkpointState: AgentCheckpointState | null,
): boolean {
  if (!checkpointState || !runtimeContext.triggerParentMessageId) {
    return false
  }

  if (
    checkpointState.activePathTailMessageId !== runtimeContext.triggerParentMessageId
  ) {
    return false
  }

  const checkpointPath = splitActivePathKey(checkpointState.activePathKey)
  const runtimePath = splitActivePathKey(runtimeContext.activePathKey)

  if (checkpointPath.at(-1) !== runtimeContext.triggerParentMessageId) {
    return false
  }

  if (!isPathPrefix(checkpointPath, runtimePath)) {
    return false
  }

  return runtimePath[checkpointPath.length] === runtimeContext.triggerUserMessageId
}

function readTriggerUserMessage(runtimeContext: AgentChatRuntimeContext): AgentChatContextMessage {
  const triggerUserMessage = runtimeContext.messages.find(message =>
    message.id === runtimeContext.triggerUserMessageId && message.role === 'user',
  )

  if (!triggerUserMessage) {
    throw new Error('聊天上下文缺少触发用户消息')
  }

  return triggerUserMessage
}

function splitActivePathKey(activePathKey: string): string[] {
  return activePathKey.split('>').filter(Boolean)
}

function isPathPrefix(prefix: string[], path: string[]): boolean {
  return prefix.every((messageId, index) => path[index] === messageId)
}
