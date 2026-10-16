import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { AgentHistoryDigest } from '../context/history-compaction'

export interface AgentCheckpointState {
  activePathKey: string
  activePathTailMessageId: string
  olderMessagesExcerpt: string
  historyDigest: AgentHistoryDigest | null
}

export async function readAgentCheckpointState(
  checkpointer: BaseCheckpointSaver | undefined,
  threadId: string,
): Promise<AgentCheckpointState | null> {
  const checkpoint = await checkpointer?.getTuple({
    configurable: {
      thread_id: threadId,
    },
  })

  if (!checkpoint) {
    return null
  }

  return parseAgentCheckpointState(checkpoint.checkpoint.channel_values)
}

function parseAgentCheckpointState(channelValues: Record<string, unknown>): AgentCheckpointState | null {
  const activePathKey = readNonEmptyString(channelValues.activePathKey)
  const activePathTailMessageId = readNonEmptyString(channelValues.activePathTailMessageId)

  if (!activePathKey || !activePathTailMessageId) {
    return null
  }

  return {
    activePathKey,
    activePathTailMessageId,
    olderMessagesExcerpt: readString(channelValues.olderMessagesExcerpt),
    historyDigest: readAgentHistoryDigest(channelValues.historyDigest),
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readAgentHistoryDigest(value: unknown): AgentHistoryDigest | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const digest = value as Partial<AgentHistoryDigest>
  if (
    digest.schemaVersion !== 1
    || typeof digest.summary !== 'string'
    || !Array.isArray(digest.coveredMessageIds)
    || !digest.coveredMessageIds.every(item => typeof item === 'string')
    || typeof digest.sourceHistoryVersion !== 'number'
    || typeof digest.estimatedTokens !== 'number'
    || typeof digest.createdAt !== 'string'
    || typeof digest.updatedAt !== 'string'
  ) {
    return null
  }

  return {
    schemaVersion: 1,
    summary: digest.summary,
    coveredMessageIds: digest.coveredMessageIds,
    sourceHistoryVersion: digest.sourceHistoryVersion,
    estimatedTokens: digest.estimatedTokens,
    createdAt: digest.createdAt,
    updatedAt: digest.updatedAt,
  }
}
