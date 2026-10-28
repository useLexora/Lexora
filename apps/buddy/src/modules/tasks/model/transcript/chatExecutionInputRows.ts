import type { LocalExecutionInputReceipt } from '@buddy-shared/executions/executionInputReceipt'
import type { ExecutionGroups } from '../executions/executionGroups'
import type { ChatAgentTurn } from './chatAgentTurn'
import type { ChatTranscriptRow } from './chatTranscriptTypes'

export function projectChatExecutionInputRows(
  rows: readonly ChatTranscriptRow[],
  inputs: readonly LocalExecutionInputReceipt[],
  turns: readonly ChatAgentTurn[],
  executions?: ExecutionGroups,
): ChatTranscriptRow[] {
  const result = [...rows]
  const rootId = (runId: string) => executions?.byRun.get(runId)?.rootRunId ?? runId
  const owner = (row: ChatTranscriptRow): string | null => {
    if (row.kind === 'execution-input')
      return row.input.rootRunId
    if (row.kind === 'message') {
      const runId = row.message.role === 'user' ? row.message.inputRunId : row.message.runId
      return runId ? rootId(runId) : null
    }
    if (row.kind === 'agent-turn' || row.kind === 'activity' || row.kind === 'turn-result')
      return rootId(row.turn.runId)
    return row.kind === 'recovery-notice' ? rootId(row.notice.runId) : null
  }
  const timestamp = (row: ChatTranscriptRow): string | null => {
    if (row.kind === 'execution-input')
      return row.input.createdAt
    if (row.kind === 'message')
      return row.message.startedAt ?? row.message.createdAt
    if (row.kind === 'agent-turn')
      return row.turn.nodeStartedAt?.[row.turn.nodes[0]?.id ?? ''] ?? row.turn.startedAt
    if (row.kind === 'turn-result')
      return row.turn.completedAt
    return null
  }
  const seen = new Set<string>()
  for (const input of inputs.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId))) {
    const execution = executions?.byRun.get(input.runId)
    if (!execution || (execution.kind !== 'root' && execution.kind !== 'actor_child')
      || execution.rootRunId !== input.rootRunId || seen.has(input.messageId)) {
      continue
    }
    seen.add(input.messageId)
    const turn = turns.find(turn => turn.runId === input.rootRunId)
    const triggerIndex = turn ? result.findIndex(row => row.kind === 'message' && row.message.id === turn.triggeringMessageId) : -1
    const owned = result.flatMap((row, index) => owner(row) === input.rootRunId ? [{ row, index }] : [])
    if (!owned.length && triggerIndex === -1)
      continue
    const following = owned.find(({ row }) => row.kind === 'activity' || (timestamp(row) ?? '') > input.createdAt)
    const index = following?.index ?? ((owned.at(-1)?.index ?? triggerIndex) + 1)
    result.splice(index, 0, { key: `execution-input:${input.messageId}`, kind: 'execution-input', input })
  }
  return result
}
