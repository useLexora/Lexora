import type { ChatAgentTurnNode } from './chatAgentTurn'
import type { PersistedChatTranscriptRow, PresentedChatTranscriptRow } from './chatTranscriptActivities'
import type { ChatTranscriptAgentTurnRow, ChatTranscriptRow } from './chatTranscriptTypes'
import { mergeChatTranscriptActivities } from './chatTranscriptActivities'

export function interleaveChatTranscriptSegments(
  rows: readonly PersistedChatTranscriptRow[],
  messageStartedAt: ReadonlyMap<string, string>,
): PresentedChatTranscriptRow[] {
  const timestamp = (row: Exclude<PersistedChatTranscriptRow, ChatTranscriptAgentTurnRow>) => row.kind === 'message'
    ? messageStartedAt.get(row.message.id) ?? row.message.createdAt
    : row.kind === 'extension-action' ? row.action.createdAt : row.compaction.createdAt
  const timeline = rows.filter(row => row.kind !== 'agent-turn').sort((left, right) => timestamp(left).localeCompare(timestamp(right)))
  const positions = new Map(timeline.map((row, index) => [row.key, index]))
  const segments = new Map<number, ChatTranscriptAgentTurnRow[]>()
  for (const row of rows) {
    if (row.kind !== 'agent-turn')
      continue
    const trigger = positions.get(`message:${row.turn.triggeringMessageId}`) ?? -1
    const groups = new Map<number, ChatAgentTurnNode[]>()
    for (const node of row.turn.nodes) {
      const startedAt = row.turn.nodeStartedAt?.[node.id]
      let position = trigger
      if (startedAt) {
        for (let index = trigger + 1; index < timeline.length; index++) {
          const candidate = timeline[index]!
          if (candidate.kind === 'message' && candidate.message.id === row.turn.finalMessageId && row.turn.status !== 'running' && row.turn.status !== 'queued')
            break
          if (timestamp(candidate) > startedAt)
            break
          position = index
        }
      }
      const nodes = groups.get(position) ?? []
      nodes.push(node)
      groups.set(position, nodes)
    }
    if (!groups.size)
      groups.set(trigger, [])
    if (row.ownsResultActions) {
      const outcomePosition = timeline.findLastIndex(candidate => candidate.kind === 'message' && (
        candidate.message.runId === row.turn.runId
        || (candidate.message.role === 'user'
          && candidate.message.branchId === row.turn.branchId
          && timestamp(candidate) >= row.turn.startedAt
          && row.turn.completedAt !== null
          && timestamp(candidate) <= row.turn.completedAt)
      ))
      if (outcomePosition > Math.max(...groups.keys()))
        groups.set(outcomePosition, [])
    }
    const ordered = [...groups].sort(([left], [right]) => left - right)
    ordered.forEach(([position, nodes], index) => {
      const siblings = segments.get(position) ?? []
      const isLast = index === ordered.length - 1
      siblings.push({
        ...row,
        ...(isLast ? {} : { ownsResultActions: undefined, showOutcome: false as const }),
        key: index === 0 ? row.key : `${row.key}:${timeline[position]!.key}`,
        turn: ordered.length === 1 ? row.turn : { ...row.turn, nodes },
      })
      segments.set(position, siblings)
    })
  }
  return alignChatAssistantIdentity(mergeChatTranscriptActivities([...(segments.get(-1) ?? []), ...timeline.flatMap((row, index) => [row, ...(segments.get(index) ?? [])])]))
}

function alignChatAssistantIdentity(rows: PresentedChatTranscriptRow[]): PresentedChatTranscriptRow[] {
  const visibleRunIds = new Set<string>()
  return rows.map((row) => {
    const runId = row.kind === 'agent-turn'
      ? row.turn.runId
      : row.kind === 'message' && row.message.role === 'assistant' ? row.message.runId : null
    if (runId === null)
      return row
    const continuation = visibleRunIds.has(runId)
    visibleRunIds.add(runId)
    return continuation ? { ...row, showIdentity: false as const } : row
  })
}

export function hasChatAssistantIdentity(rows: readonly ChatTranscriptRow[], runId: string | null): boolean {
  return runId !== null && rows.some(row => row.kind === 'agent-turn'
    ? row.turn.runId === runId
    : row.kind === 'message' && row.message.role === 'assistant' && !row.streaming && row.message.runId === runId)
}
