import type { ExecutionGroups } from '../executions/executionGroups'
import type { ChatAgentTurn } from './chatAgentTurn'
import type { ChatTranscriptRow } from './chatTranscriptTypes'
import { orderChatTurnRows } from './orderChatTurnRows'

export function groupChatTranscriptRows(
  rows: readonly ChatTranscriptRow[],
  turns: readonly ChatAgentTurn[],
  executions?: ExecutionGroups,
): ChatTranscriptRow[] {
  const rootId = (runId: string) => executions?.byRun.get(runId)?.rootRunId ?? runId
  return orderChatTurnRows(rows, turns.filter(turn => rootId(turn.runId) === turn.runId), row => row.kind === 'message' && row.message.role === 'user' ? row.message : undefined, (row) => {
    if (row.kind === 'user-question')
      return row.request.rootRunId
    if (row.kind === 'execution-input')
      return row.input.rootRunId
    const runId = row.kind === 'message'
      ? row.message.role === 'user' ? row.message.inputRunId : row.message.runId
      : row.kind === 'recovery-notice'
        ? row.notice.runId
        : row.kind === 'agent-turn' || row.kind === 'activity' || row.kind === 'turn-result' ? row.turn.runId : null
    return runId && rootId(runId)
  })
}
