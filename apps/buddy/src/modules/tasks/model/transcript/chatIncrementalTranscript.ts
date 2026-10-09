import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalConversationTimelineItem, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunOutput } from '@buddy-shared/runs/runApi'

import type { ChatAgentTurn } from './chatAgentTurn'
import type { ChatRunTranscriptProjection } from './chatRunTranscriptProjector'
import type {
  ChatTranscriptMessageRow,
  ChatTranscriptProjection,
  ChatTranscriptProjectionInput,
  ChatTranscriptRow,
  ChatTranscriptRowPatch,
} from './chatTranscriptTypes'
import { isVisibleExtensionAction, shouldShowAgentTurn } from './chatPersistedTranscriptRows'
import { selectChatStreamingMessage } from './chatRunStreamingMessages'
import { hasChatAssistantIdentity } from './chatTranscriptSegments'

export interface CachedChatTranscriptProjection {
  includeUnanchoredTurns: boolean
  interleavedRunIds: ReadonlySet<string>
  activityRowIndex: number | null
  activeRunId: string | null
  agentTurnRowIndexByRunId: ReadonlyMap<string, number>
  changeSets: ReadonlyArray<LocalChangeSetSummary>
  messages: ReadonlyArray<LocalMessage>
  outputs: ReadonlyArray<LocalRunOutput>
  projection: ChatTranscriptProjection
  runProjectionIds: ReadonlySet<string>
  runProjections: ReadonlyArray<ChatRunTranscriptProjection> | null
  runs: ReadonlyArray<LocalRun>
  streamingRowIndex: number | null
  timelineItems: ReadonlyArray<LocalConversationTimelineItem>
}

const EMPTY_CHANGE_SETS: ReadonlyArray<LocalChangeSetSummary> = []

export function projectIncrementalChatTranscript(
  cached: CachedChatTranscriptProjection,
  input: ChatTranscriptProjectionInput,
): {
  cache: CachedChatTranscriptProjection
  projection: ChatTranscriptProjection
} | null {
  const runProjections = input.runProjections
  if (
    !runProjections
    || cached.includeUnanchoredTurns !== (input.includeUnanchoredTurns ?? false)
    || !cached.runProjections
    || cached.timelineItems !== input.timelineItems
    || cached.runs !== input.runs
    || cached.outputs !== input.outputs
    || cached.changeSets !== (input.changeSets ?? EMPTY_CHANGE_SETS)
    || cached.runProjections.length !== runProjections.length
  ) {
    return null
  }

  const changed: Array<{
    next: ChatRunTranscriptProjection
    previous: ChatRunTranscriptProjection
  }> = []
  for (let index = 0; index < runProjections.length; index += 1) {
    const previous = cached.runProjections[index]!
    const next = runProjections[index]!
    if (previous.turn.runId !== next.turn.runId)
      return null
    if (previous === next)
      continue
    if (cached.interleavedRunIds.has(next.turn.runId))
      return null
    if (
      !hasSameRecoveryNotices(previous, next)
      || !hasSameTurnRowStructure(previous.turn, next.turn)
    ) {
      return null
    }
    changed.push({ next, previous })
  }

  if (changed.length === 0) {
    return {
      cache: { ...cached, runProjections },
      projection: cached.projection,
    }
  }

  let rows: ChatTranscriptRow[] | null = null
  const patches: ChatTranscriptRowPatch[] = []
  const editableRows = () => rows ??= [...cached.projection.rows]
  const patchRows = (patch: ChatTranscriptRowPatch) => {
    editableRows().splice(patch.index, patch.deleteCount, ...patch.rows)
    patches.push(patch)
  }
  for (const { next, previous } of changed) {
    if (next.turn === previous.turn)
      continue
    const rowIndex = cached.agentTurnRowIndexByRunId.get(next.turn.runId)
    if (rowIndex === undefined)
      continue
    const row = cached.projection.rows[rowIndex]
    if (row?.kind !== 'agent-turn')
      return null
    patchRows({
      deleteCount: 1,
      index: rowIndex,
      rows: [{ ...row, turn: next.turn }],
    })
  }

  const streamingMessage = selectChatStreamingMessage(
    cached.messages,
    runProjections.flatMap(projection => projection.streamingMessages),
    input.runs,
  )?.message ?? null
  let streamingRowIndex = cached.streamingRowIndex
  let activityRowIndex = cached.activityRowIndex
  if (streamingMessage) {
    const nextStreamingRow: ChatTranscriptMessageRow = {
      ...(hasChatAssistantIdentity(rows ?? cached.projection.rows, streamingMessage.runId) ? { showIdentity: false as const } : {}),
      isIntermediate: true,
      key: `message:${streamingMessage.id}`,
      kind: 'message',
      message: streamingMessage,
      streaming: true,
      turnOutputs: null,
    }
    if (streamingRowIndex === null) {
      streamingRowIndex = activityRowIndex ?? cached.projection.rows.length
      patchRows({
        deleteCount: 0,
        index: streamingRowIndex,
        rows: [nextStreamingRow],
      })
      if (activityRowIndex !== null)
        activityRowIndex += 1
    }
    else {
      patchRows({
        deleteCount: 1,
        index: streamingRowIndex,
        rows: [nextStreamingRow],
      })
    }
  }
  else if (streamingRowIndex !== null) {
    patchRows({
      deleteCount: 1,
      index: streamingRowIndex,
      rows: [],
    })
    if (activityRowIndex !== null && activityRowIndex > streamingRowIndex)
      activityRowIndex -= 1
    streamingRowIndex = null
  }

  if (activityRowIndex !== null && cached.activeRunId) {
    const nextActiveTurn = runProjections.find(
      projection => projection.turn.runId === cached.activeRunId,
    )?.turn
    const row = (rows ?? cached.projection.rows)[activityRowIndex]
    if (!nextActiveTurn || row?.kind !== 'activity')
      return null
    if (row.turn !== nextActiveTurn) {
      patchRows({
        deleteCount: 1,
        index: activityRowIndex,
        rows: [{ ...row, turn: nextActiveTurn }],
      })
    }
  }

  const projection: ChatTranscriptProjection = rows
    ? {
        rows,
        update: {
          kind: 'patch',
          patches,
          previousRows: cached.projection.rows,
        },
      }
    : cached.projection
  return {
    cache: {
      ...cached,
      activityRowIndex,
      projection,
      runProjections,
      streamingRowIndex,
    },
    projection,
  }
}

export function createChatTranscriptProjectionCache(
  input: ChatTranscriptProjectionInput,
  projection: ChatTranscriptProjection,
): CachedChatTranscriptProjection {
  const agentTurnRowIndexByRunId = new Map<string, number>()
  let activityRowIndex: number | null = null
  let activeRunId: string | null = null
  let streamingRowIndex: number | null = null
  projection.rows.forEach((row, index) => {
    if (row.kind === 'agent-turn') {
      agentTurnRowIndexByRunId.set(row.turn.runId, index)
    }
    else if (row.kind === 'activity') {
      activityRowIndex = index
      activeRunId = row.turn.runId
    }
    else if (row.kind === 'message' && row.streaming) {
      streamingRowIndex = index
    }
  })
  const runProjections = input.runProjections ?? null
  const interleavedRunIds = new Set(input.runs.filter(run => input.timelineItems.some(item => (
    item.kind === 'extension-action'
      ? isVisibleExtensionAction(item)
      && item.branchId === run.branchId
      && item.sourceMessageId === run.triggeringMessageId
      : item.kind === 'message'
        && item.role === 'user'
        && item.id !== run.triggeringMessageId
        && item.branchId === run.branchId
        && item.createdAt >= run.startedAt
        && (run.completedAt === null || item.createdAt <= run.completedAt)
  ))).map(run => run.id))
  const seenTurns = new Set<string>()
  for (const row of projection.rows) {
    if (row.kind !== 'agent-turn')
      continue
    if (seenTurns.has(row.turn.runId) || row.turn.nodes.some(node => node.kind === 'tool' && node.invocation))
      interleavedRunIds.add(row.turn.runId)
    seenTurns.add(row.turn.runId)
  }
  return {
    includeUnanchoredTurns: input.includeUnanchoredTurns ?? false,
    interleavedRunIds,
    activityRowIndex,
    activeRunId,
    agentTurnRowIndexByRunId,
    changeSets: input.changeSets ?? EMPTY_CHANGE_SETS,
    messages: input.timelineItems.filter(
      (item): item is Extract<LocalConversationTimelineItem, { kind: 'message' }> =>
        item.kind === 'message',
    ),
    outputs: input.outputs,
    projection,
    runProjectionIds: new Set(runProjections?.map(item => item.turn.runId) ?? []),
    runProjections,
    runs: input.runs,
    streamingRowIndex,
    timelineItems: input.timelineItems,
  }
}

function hasSameRecoveryNotices(
  previous: ChatRunTranscriptProjection,
  next: ChatRunTranscriptProjection,
): boolean {
  return previous.recoveryNotices === next.recoveryNotices
    || (
      previous.recoveryNotices.length === next.recoveryNotices.length
      && previous.recoveryNotices.every((notice, index) => next.recoveryNotices[index] === notice)
    )
}

function hasSameTurnRowStructure(previous: ChatAgentTurn, next: ChatAgentTurn): boolean {
  return previous.runId === next.runId
    && previous.branchId === next.branchId
    && previous.triggeringMessageId === next.triggeringMessageId
    && previous.finalMessageId === next.finalMessageId
    && previous.startedAt === next.startedAt
    && previous.status === next.status
    && shouldShowAgentTurn(previous) === shouldShowAgentTurn(next)
    && hasSameProcessMessageIds(previous, next)
}

function hasSameProcessMessageIds(previous: ChatAgentTurn, next: ChatAgentTurn): boolean {
  const previousIds = previous.processMessageIds
  const nextIds = next.processMessageIds
  return previousIds.length === nextIds.length
    && previousIds.every((messageId, index) => nextIds[index] === messageId)
}
