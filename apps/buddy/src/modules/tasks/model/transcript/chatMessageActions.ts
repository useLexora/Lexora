import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'

import type { ChatAgentTurn } from './chatAgentTurn'
import type { ChatTranscriptMessageRow, ChatTranscriptRow } from './chatTranscriptTypes'

export interface ChatMessageActions {
  disabled: boolean
  showCopy: boolean
  showEdit: boolean
  showFollowup: boolean
  showRegenerate: boolean
  showTime: boolean
}

export interface ChatTranscriptResultTarget {
  branchNavigatorId: string
  branchId: string
  followupMessageId: string | null
  regenerateRunId: string | null
  usageRunId: string | null
}

type ChatMessageResultSource = Pick<ChatTranscriptMessageRow, 'message' | 'turnResult' | 'resultRunId'> & { ownsResultActions?: boolean }

export function getChatMessageResultTarget(row: ChatMessageResultSource): ChatTranscriptResultTarget {
  return {
    branchNavigatorId: row.turnResult?.runId ?? row.message.id,
    branchId: row.turnResult?.branchId ?? row.message.branchId,
    followupMessageId: row.turnResult?.finalMessageId ?? (row.ownsResultActions ? row.message.id : null),
    regenerateRunId: row.turnResult?.runId ?? (row.ownsResultActions ? row.message.runId : null),
    usageRunId: row.turnResult?.runId ?? (row.ownsResultActions ? row.resultRunId ?? null : null),
  }
}

export function getChatTranscriptResultTarget(row: ChatTranscriptRow): ChatTranscriptResultTarget | null {
  if (row.kind === 'message')
    return getChatMessageResultTarget(row)
  if (row.kind === 'agent-turn' || row.kind === 'turn-result') {
    return {
      branchNavigatorId: row.turn.runId,
      branchId: row.turn.branchId,
      followupMessageId: row.turn.finalMessageId,
      regenerateRunId: row.turn.runId,
      usageRunId: row.turn.runId,
    }
  }
  return null
}

export function getChatMessageFollowupSourceId(row: ChatMessageResultSource): string | null {
  return getChatMessageResultTarget(row).followupMessageId
}

export function projectChatFollowupMessageIds(
  rows: readonly ChatTranscriptRow[],
  completedRunIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const finalMessages = new Map<string, { messageId: string, index: number, available: boolean }>()
  let lastMessageIndex = -1
  for (const [index, row] of rows.entries()) {
    if (row.kind === 'message' && (row.message.role === 'user' || row.message.role === 'assistant')) {
      lastMessageIndex = index
      const messageId = getChatMessageFollowupSourceId(row)
      const runId = row.turnResult?.runId ?? row.message.runId
      if (row.message.role === 'assistant' && messageId && runId) {
        finalMessages.set(runId, {
          messageId,
          index,
          available: !row.streaming && !row.isIntermediate && row.showActions !== false,
        })
      }
    }
    else if ((row.kind === 'turn-result' || (row.kind === 'agent-turn' && row.ownsResultActions)) && row.turn.finalMessageId) {
      finalMessages.set(row.turn.runId, {
        messageId: row.turn.finalMessageId,
        index,
        available: row.turn.status === 'completed',
      })
    }
  }
  return new Set([...finalMessages].flatMap(([runId, source]) =>
    completedRunIds.has(runId) && source.available && source.index < lastMessageIndex
      ? [source.messageId]
      : [],
  ))
}

export function projectChatMessageActions(
  message: LocalMessage,
  disabled: boolean,
  ownsResultActions: boolean,
  canFollowup = false,
): ChatMessageActions {
  const lifecycleMessage = message.role === 'user' || message.role === 'assistant'
  return {
    disabled,
    showCopy: lifecycleMessage,
    showEdit: message.role === 'user',
    showFollowup: ownsResultActions && canFollowup && message.role === 'assistant' && message.runId !== null,
    showRegenerate: ownsResultActions && message.role === 'assistant' && message.runId !== null,
    showTime: lifecycleMessage,
  }
}

export function projectChatAgentTurnActions(
  turn: ChatAgentTurn,
  disabled: boolean,
  ownsResultActions: boolean,
  canFollowup = false,
): ChatMessageActions {
  const showActions = ownsResultActions
    && (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled')
  return {
    disabled,
    showCopy: showActions && turn.status !== 'completed',
    showEdit: false,
    showFollowup: canFollowup && showActions && turn.status === 'completed' && turn.finalMessageId !== null,
    showRegenerate: showActions,
    showTime: showActions,
  }
}
