import type { LocalConversationTimelineItem, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'

import type { CachedChatTranscriptProjection } from './chatIncrementalTranscript'
import type {
  ChatTranscriptProjection,
  ChatTranscriptProjectionInput,
  ChatTranscriptRecoveryNoticeRow,
  ChatTranscriptRow,
} from './chatTranscriptTypes'
import { projectChatAgentTurns } from './chatAgentTurn'
import { createChatTranscriptProjectionCache, projectIncrementalChatTranscript } from './chatIncrementalTranscript'
import { projectPersistedChatTranscriptRows } from './chatPersistedTranscriptRows'
import { projectChatRecoveryNotices, selectChatRecoveryNotices } from './chatRunRecovery'
import { projectStreamingAssistantMessage, selectChatStreamingMessage } from './chatRunStreamingMessages'
import { presentChatTranscript } from './chatTranscriptPresentation'

export { projectPersistedChatTranscriptRows } from './chatPersistedTranscriptRows'
export type {
  ChatTranscriptActivityRow,
  ChatTranscriptAgentTurnRow,
  ChatTranscriptCompactionRow,
  ChatTranscriptMessageRow,
  ChatTranscriptProjection,
  ChatTranscriptProjectionInput,
  ChatTranscriptProjectionUpdate,
  ChatTranscriptRecoveryNoticeRow,
  ChatTranscriptRow,
  ChatTranscriptRowPatch,
  ChatTranscriptTurnOutputs,
} from './chatTranscriptTypes'

export function projectChatTranscript(
  input: ChatTranscriptProjectionInput,
): ChatTranscriptProjection {
  return projectChatTranscriptState(input).projection
}

function projectChatTranscriptState(input: ChatTranscriptProjectionInput) {
  const messages = input.timelineItems.filter(
    (item): item is Extract<LocalConversationTimelineItem, { kind: 'message' }> =>
      item.kind === 'message',
  )
  const runEvents = input.runEvents ?? []
  const agentTurns = input.runProjections?.map(projection => projection.turn)
    ?? input.agentTurns
    ?? projectChatAgentTurns(runEvents, input.runs)
  const recoveryNotices = input.runProjections
    ? selectChatRecoveryNotices(
        input.timelineItems,
        input.runProjections.flatMap(projection => projection.recoveryNotices),
        input.runs,
      )
    : projectChatRecoveryNotices(input.timelineItems, runEvents, input.runs)
  const streamingLocalMessage = input.runProjections
    ? selectChatStreamingMessage(
      messages,
      input.runProjections.flatMap(projection => projection.streamingMessages),
      input.runs,
    )?.message ?? null
    : projectLegacyStreamingLocalMessage(messages, runEvents, input.runs)
  const triggeringMessageIdByRunId = new Map(
    input.runs.map(run => [run.id, run.triggeringMessageId]),
  )
  const noticesByMessageId = new Map<string, ChatTranscriptRecoveryNoticeRow[]>()
  const noticesByRunId = new Map<string, ChatTranscriptRecoveryNoticeRow[]>()
  for (const notice of recoveryNotices) {
    const messageId = triggeringMessageIdByRunId.get(notice.runId)
    if (!messageId)
      continue
    const row: ChatTranscriptRecoveryNoticeRow = {
      key: `recovery-notice:${notice.runId}:${notice.sequence}`,
      kind: 'recovery-notice',
      notice,
    }
    const messageRows = noticesByMessageId.get(messageId) ?? []
    messageRows.push(row)
    noticesByMessageId.set(messageId, messageRows)
    const runRows = noticesByRunId.get(notice.runId) ?? []
    runRows.push(row)
    noticesByRunId.set(notice.runId, runRows)
  }

  const agentTurnRunIds = new Set(agentTurns.map(turn => turn.runId))
  const noticeRunIds = new Set<string>()
  const rows: ChatTranscriptRow[] = []
  for (const row of projectPersistedChatTranscriptRows(
    streamingLocalMessage ? [...input.timelineItems, { ...streamingLocalMessage, kind: 'message' }] : input.timelineItems,
    agentTurns,
    input.outputs,
    input.changeSets ?? [],
    input.includeUnanchoredTurns,
  )) {
    rows.push(streamingLocalMessage && row.kind === 'message' && row.message.id === streamingLocalMessage.id
      ? { ...row, message: streamingLocalMessage, streaming: true }
      : row)
    if (row.kind === 'agent-turn') {
      if (!noticeRunIds.has(row.turn.runId)) {
        rows.push(...(noticesByRunId.get(row.turn.runId) ?? []))
        noticeRunIds.add(row.turn.runId)
      }
      continue
    }
    if (row.kind === 'message') {
      rows.push(...(noticesByMessageId.get(row.message.id) ?? []).filter(
        notice => !agentTurnRunIds.has(notice.notice.runId),
      ))
    }
  }
  const visibleRunIds = new Set(rows.flatMap(row => row.kind === 'agent-turn' ? [row.turn.runId] : []))
  const activeAgentTurn = [...agentTurns].reverse().find(turn => visibleRunIds.has(turn.runId) && (turn.status === 'queued' || turn.status === 'running'))
  if (activeAgentTurn) {
    rows.push({
      key: `activity:${activeAgentTurn.runId}`,
      kind: 'activity',
      turn: activeAgentTurn,
    })
  }

  const presented = presentChatTranscript(rows, input.executionGroups)
  return {
    projection: { rows: presented.rows, update: { kind: 'replace' as const } },
    continuation: presented.continuation,
  }
}

export function createChatTranscriptProjector() {
  let cached: CachedChatTranscriptProjection | null = null

  return {
    project(input: ChatTranscriptProjectionInput): ChatTranscriptProjection {
      const incremental = cached && projectIncrementalChatTranscript(cached, input)
      if (incremental) {
        cached = incremental.cache
        return incremental.projection
      }
      const state = projectChatTranscriptState(input)
      const projection = state.projection
      if (cached) {
        const previous = new Map(cached.projection.rows.map(row => [row.key, row]))
        projection.rows = projection.rows.map((row) => {
          const existing = previous.get(row.key)
          if (!existing)
            return row
          const fields = Object.entries(row)
          return fields.length === Object.keys(existing).length
            && fields.every(([key, value]) => existing[key as keyof ChatTranscriptRow] === value)
            ? existing
            : row
        })
      }
      cached = createChatTranscriptProjectionCache(input, projection, state.continuation)
      return projection
    },
  }
}

function projectLegacyStreamingLocalMessage(
  messages: ReadonlyArray<LocalMessage>,
  events: ReadonlyArray<LocalRunEvent>,
  runs: ReadonlyArray<LocalRun>,
): LocalMessage | null {
  const streamingMessage = projectStreamingAssistantMessage(messages, events, runs)
  return streamingMessage
    ? projectStreamingLocalMessage(streamingMessage.id, streamingMessage.text, events, runs)
    : null
}

function projectStreamingLocalMessage(
  messageId: string,
  text: string,
  events: ReadonlyArray<LocalRunEvent>,
  runs: ReadonlyArray<LocalRun>,
): LocalMessage | null {
  const sourceEvent = [...events].reverse().find(event => (
    readMessageId(event.payload) === messageId
  ))
  if (!sourceEvent)
    return null
  const run = runs.find(item => item.id === sourceEvent.runId)
  if (!run)
    return null
  const startedAt = events.find(event => (
    event.runId === run.id
    && event.type === 'message.started'
    && readMessageId(event.payload) === messageId
  ))?.createdAt ?? sourceEvent.createdAt
  return {
    attachments: [],
    branchId: run.branchId,
    content: { text },
    conversationId: run.conversationId,
    createdAt: startedAt,
    id: messageId,
    role: 'assistant',
    runId: run.id,
  }
}

function readMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null
  const messageId = (payload as Record<string, unknown>).messageId
  return typeof messageId === 'string' ? messageId : null
}
