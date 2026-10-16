import type {
  AgentChatContextMessage,
  AgentChatContextSnapshot,
} from '@haohaoxue/lexora-contracts'
import type { BaseMessage, MessageContent } from '@langchain/core/messages'
import { estimateTextTokenCount } from '@haohaoxue/lexora-shared/tokens'

export type AgentTokenEstimationSource = 'heuristic'

export interface AgentTokenEstimate {
  estimatedTokens: number
  estimationSource: AgentTokenEstimationSource
  safetyMultiplier: number
}

export interface AgentTokenEstimator {
  estimateTextTokens: (text: string) => AgentTokenEstimate
  estimateMessageTokens: (message: Pick<AgentChatContextMessage, 'role' | 'content'>) => AgentTokenEstimate
  estimateMessagesTokens: (messages: Array<Pick<AgentChatContextMessage, 'role' | 'content'>>) => AgentTokenEstimate
  estimateContextSnapshotTokens: (snapshot: Pick<AgentChatContextSnapshot, 'content'>) => AgentTokenEstimate
  estimateBaseMessageTokens: (message: BaseMessage) => AgentTokenEstimate
  estimateBaseMessagesTokens: (messages: BaseMessage[]) => AgentTokenEstimate
}

const MESSAGE_OVERHEAD_TOKENS = 4
const SAFETY_MULTIPLIER = 1.15

export function createHeuristicTokenEstimator(): AgentTokenEstimator {
  return {
    estimateTextTokens,
    estimateMessageTokens(message) {
      return toEstimate(MESSAGE_OVERHEAD_TOKENS + estimateRawTextTokens(message.content))
    },
    estimateMessagesTokens(messages) {
      return sumEstimates(messages.map(message => this.estimateMessageTokens(message)))
    },
    estimateContextSnapshotTokens(snapshot) {
      return toEstimate(MESSAGE_OVERHEAD_TOKENS + estimateRawTextTokens(snapshot.content))
    },
    estimateBaseMessageTokens(message) {
      return toEstimate(MESSAGE_OVERHEAD_TOKENS + estimateMessageContentTokens(message.content))
    },
    estimateBaseMessagesTokens(messages) {
      return sumEstimates(messages.map(message => this.estimateBaseMessageTokens(message)))
    },
  }
}

export const defaultAgentTokenEstimator = createHeuristicTokenEstimator()

export function estimateTextTokens(text: string): AgentTokenEstimate {
  return toEstimate(estimateRawTextTokens(text))
}

function estimateRawTextTokens(text: string): number {
  if (!text) {
    return 0
  }

  return estimateTextTokenCount(text, {
    safetyMultiplier: SAFETY_MULTIPLIER,
  })
}

function estimateMessageContentTokens(content: MessageContent): number {
  if (typeof content === 'string') {
    return estimateRawTextTokens(content)
  }

  return content.reduce((total, block) => {
    if (typeof block === 'string') {
      return total + estimateRawTextTokens(block)
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      return total + estimateRawTextTokens(block.text)
    }

    return total + MESSAGE_OVERHEAD_TOKENS
  }, 0)
}

function sumEstimates(estimates: AgentTokenEstimate[]): AgentTokenEstimate {
  return toEstimate(estimates.reduce((total, estimate) => total + estimate.estimatedTokens, 0), false)
}

function toEstimate(tokens: number, applySafety = true): AgentTokenEstimate {
  return {
    estimatedTokens: Math.max(0, Math.ceil(applySafety ? tokens : tokens)),
    estimationSource: 'heuristic',
    safetyMultiplier: SAFETY_MULTIPLIER,
  }
}
