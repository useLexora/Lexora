import type { ExecutionGroups } from '../executions/executionGroups'
import type { ChatTranscriptAgentTurnRow, ChatTranscriptMessageRow, ChatTranscriptRow } from './chatTranscriptTypes'

export interface ChatTranscriptContinuation {
  precedingAssistantRunId: string | null
}

export function presentChatTranscript(rows: readonly ChatTranscriptRow[], executions?: ExecutionGroups) {
  let precedingAssistantRunId: string | null = null
  let precedingSpeaker: string | null = null
  let hasAssistantSinceUser = false
  let streamingContinuation: ChatTranscriptContinuation | null = null
  let speech: ChatTranscriptMessageRow[] = []
  let speechEnd: ChatTranscriptMessageRow | ChatTranscriptAgentTurnRow | null = null
  const presented: ChatTranscriptRow[] = []
  const identifiedRunIds = new Set<string>()
  const turnsByRunId = new Map(rows.flatMap(row => row.kind === 'agent-turn' || row.kind === 'turn-result' ? [[row.turn.runId, row.turn] as const] : []))
  const speaker = (runId: string) => {
    const execution = executions?.byRun.get(runId)
    return execution ? `${execution.rootRunId}:${execution.buddyId}` : runId
  }
  const finishSpeech = (handedOff: boolean) => {
    if (handedOff && speechEnd)
      speechEnd.endsSpeech = true
    const last = speech.at(-1)
    if (last) {
      const execution = last.message.runId ? executions?.byRun.get(last.message.runId) : null
      if (!handedOff && (last.isIntermediate || (execution && execution.phase !== 'closed')))
        last.showActions = false
      if (speech.length > 1)
        last.actionMessages = speech.map(row => row.message)
    }
    speech = []
    speechEnd = null
  }
  for (let row of rows) {
    const runId = row.kind === 'agent-turn'
      ? row.turn.runId
      : row.kind === 'message' && row.message.role === 'assistant' ? row.message.runId : null
    if (!runId) {
      if (row.kind === 'message' && row.message.role === 'user') {
        finishSpeech(true)
        hasAssistantSinceUser = false
      }
      presented.push(row)
      continue
    }
    const currentSpeaker = speaker(runId)
    if (row.kind === 'agent-turn' && !row.ownsResultActions
      && !row.turn.nodes.some(node => node.kind === 'text' && node.text.trim())
      && hasAssistantSinceUser && precedingSpeaker && precedingSpeaker !== currentSpeaker) {
      const nodes = row.turn.nodes.filter(node => node.kind !== 'tool' || node.toolName !== 'lexora_agents' || node.isError)
      if (!nodes.length)
        continue
      row = { ...row, showOutcome: false, turn: { ...row.turn, nodes } }
    }
    if (precedingAssistantRunId !== runId)
      finishSpeech(true)
    const showIdentity = currentSpeaker !== precedingSpeaker || !identifiedRunIds.has(runId)
    const execution = showIdentity && !identifiedRunIds.has(runId)
      ? executions?.byRun.get(runId) ?? turnsByRunId.get(runId)
      : null
    const executionStatus = execution ? { status: execution.status, startedAt: execution.startedAt, completedAt: execution.completedAt } : undefined
    if (showIdentity)
      identifiedRunIds.add(runId)
    if (row.kind === 'message' && row.streaming)
      streamingContinuation = { precedingAssistantRunId }
    precedingAssistantRunId = runId
    precedingSpeaker = currentSpeaker
    hasAssistantSinceUser = true
    if (row.kind === 'message') {
      const previous = speech.at(-1)
      if (previous)
        previous.showActions = false
      const message = { ...row, ...(executionStatus ? { executionStatus } : {}), ...(showIdentity ? {} : { showIdentity: false as const }) }
      speech.push(message)
      presented.push(message)
      speechEnd = message
    }
    else if (row.kind === 'agent-turn') {
      const turn = { ...row, ...(executionStatus ? { executionStatus } : {}), ...(showIdentity ? {} : { showIdentity: false as const }) }
      presented.push(turn)
      speechEnd = turn
    }
  }
  finishSpeech(false)
  const actorMessages = new Map<string, ChatTranscriptMessageRow>()
  for (const row of presented) {
    if (row.kind !== 'message' || !row.message.runId)
      continue
    const execution = executions?.byRun.get(row.message.runId)
    if (execution?.kind === 'actor_child' && (execution.toolCount > 0 || execution.status === 'failed' || execution.cleanup === 'degraded'))
      actorMessages.set(row.message.runId, row)
  }
  for (const [runId, row] of actorMessages)
    row.processRunId = runId
  return {
    rows: attachTurnResults(presented, executions),
    continuation: streamingContinuation ?? { precedingAssistantRunId },
  }
}

function attachTurnResults(rows: readonly ChatTranscriptRow[], executions?: ExecutionGroups): ChatTranscriptRow[] {
  const combined: ChatTranscriptRow[] = []
  for (const row of rows) {
    const previous = combined.at(-1)
    const messageRunId = previous?.kind === 'message' ? previous.message.runId : null
    if (row.kind === 'turn-result' && previous?.kind === 'message' && previous.message.role === 'assistant'
      && !previous.streaming && messageRunId && !previous.turnResult
      && previous.message.branchId === row.turn.branchId
      && (messageRunId === row.turn.runId || executions?.byRun.get(messageRunId)?.rootRunId === row.turn.runId)) {
      combined[combined.length - 1] = { ...previous, showActions: undefined, turnResult: row.turn }
    }
    else {
      combined.push(row)
    }
  }
  return combined
}
