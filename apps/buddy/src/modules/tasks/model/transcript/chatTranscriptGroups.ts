import type { ExecutionGroups } from '../executions/executionGroups'
import type { ChatAgentTurn } from './chatAgentTurn'
import type { ChatTranscriptRow } from './chatTranscriptTypes'

export function groupChatTranscriptRows(
  rows: readonly ChatTranscriptRow[],
  turns: readonly ChatAgentTurn[],
  executions?: ExecutionGroups,
): ChatTranscriptRow[] {
  const rootId = (runId: string) => executions?.byRun.get(runId)?.rootRunId ?? runId
  const userIds = new Set(rows.flatMap(row => row.kind === 'message' && row.message.role === 'user' ? [row.message.id] : []))
  const roots = turns.filter(turn => rootId(turn.runId) === turn.runId && userIds.has(turn.triggeringMessageId))
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt) || left.runId.localeCompare(right.runId))
  if (roots.length < 2)
    return [...rows]
  const byRoot = new Map(roots.map(turn => [turn.runId, [] as ChatTranscriptRow[]]))
  const byTrigger = new Map<string, string[]>()
  for (const turn of roots) {
    const siblings = byTrigger.get(turn.triggeringMessageId) ?? []
    siblings.push(turn.runId)
    byTrigger.set(turn.triggeringMessageId, siblings)
  }
  if (rows.some(row => row.kind === 'message' && row.message.role === 'user'
    && !byTrigger.has(row.message.id)
    && (!row.message.inputRunId || !byRoot.has(rootId(row.message.inputRunId)))
    && roots.some(turn => row.message.branchId === turn.branchId
      && row.message.createdAt >= turn.startedAt
      && (!turn.completedAt || row.message.createdAt <= turn.completedAt)))) {
    return [...rows]
  }
  const owner = (row: ChatTranscriptRow) => {
    if (row.kind === 'execution-input')
      return byRoot.get(row.input.rootRunId)
    const runId = row.kind === 'message'
      ? row.message.role === 'user' ? row.message.inputRunId : row.message.runId
      : row.kind === 'recovery-notice'
        ? row.notice.runId
        : row.kind === 'agent-turn' || row.kind === 'activity' || row.kind === 'turn-result' ? row.turn.runId : null
    return runId ? byRoot.get(rootId(runId)) : undefined
  }
  for (const row of rows) {
    if (row.kind === 'message' && row.message.role === 'user' && byTrigger.has(row.message.id))
      continue
    owner(row)?.push(row)
  }
  return rows.flatMap((row) => {
    if (row.kind === 'message' && row.message.role === 'user' && byTrigger.has(row.message.id))
      return [row, ...byTrigger.get(row.message.id)!.flatMap(runId => byRoot.get(runId)!)]
    return owner(row) ? [] : [row]
  })
}
