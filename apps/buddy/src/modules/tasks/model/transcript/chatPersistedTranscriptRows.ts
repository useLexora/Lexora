import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalConversationTimelineItem, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { ExtensionActionTimelineItem } from '@buddy-shared/extensions/extensionActionApi'
import type { LocalRunOutput } from '@buddy-shared/runs/runApi'

import type { ChatAgentTurn } from './chatAgentTurn'
import type { PersistedChatTranscriptRow, PresentedChatTranscriptRow } from './chatTranscriptActivities'
import type {
  ChatTranscriptMessageRow,
  ChatTranscriptTurnOutputs,
} from './chatTranscriptTypes'
import { projectConversationCompactionState } from './chatConversationTimeline'
import { isVisibleChatMessage } from './chatMessageContent'
import { projectChatTurnExtensionActions } from './chatTranscriptActivities'
import { interleaveChatTranscriptSegments } from './chatTranscriptSegments'

export function projectPersistedChatTranscriptRows(
  items: ReadonlyArray<LocalConversationTimelineItem>,
  turns: ReadonlyArray<ChatAgentTurn>,
  outputs: ReadonlyArray<LocalRunOutput> = [],
  changeSets: ReadonlyArray<LocalChangeSetSummary> = [],
  includeUnanchoredTurns = false,
): PresentedChatTranscriptRow[] {
  const rows: PersistedChatTranscriptRow[] = []
  const turnsByTrigger = new Map<string, ChatAgentTurn[]>()
  const turnsByRunId = new Map(turns.map(turn => [turn.runId, turn]))
  const outputsByRunId = projectTurnOutputs(outputs)
  const changesByRunId = new Map(changeSets
    .filter(changeSet => changeSet.fileCount > 0)
    .map(changeSet => [changeSet.runId, changeSet]))
  const renderedResultRunIds = new Set(items.flatMap((item) => {
    if (
      item.kind !== 'message'
      || !item.runId
      || !isFinalTurnMessage(item, turnsByRunId)
      || (
        !isVisibleChatMessage(item)
        && !outputsByRunId.has(item.runId)
        && !changesByRunId.has(item.runId)
      )
    ) {
      return []
    }
    return [item.runId]
  }))
  const processMessageIds = new Set(turns.flatMap(turn => turn.processMessageIds))
  const timelineMessageIds = new Set(items.filter(item => item.kind === 'message').map(item => item.id))
  const visibleActions = items.filter(isVisibleExtensionAction)
  const activities = projectChatTurnExtensionActions(
    turns.filter(turn => includeUnanchoredTurns || timelineMessageIds.has(turn.triggeringMessageId)),
    visibleActions,
    items.filter(item => item.kind === 'message'),
  )
  const independentActionIds = new Set(activities.independentActions.map(action => action.id))
  for (const turn of activities.turns) {
    if (!shouldShowAgentTurn(turn))
      continue
    if (includeUnanchoredTurns && !timelineMessageIds.has(turn.triggeringMessageId)) {
      rows.push({
        key: `agent-turn:${turn.runId}`,
        kind: 'agent-turn',
        turn,
        ...((turn.status === 'failed' || turn.status === 'cancelled') && !renderedResultRunIds.has(turn.runId) ? { ownsResultActions: true as const } : {}),
      })
      continue
    }
    const candidates = turnsByTrigger.get(turn.triggeringMessageId) ?? []
    candidates.push(turn)
    turnsByTrigger.set(turn.triggeringMessageId, candidates)
  }

  for (const item of items) {
    if (item.kind === 'extension-action') {
      if (independentActionIds.has(item.id))
        rows.push({ action: item, key: `extension-action:${item.id}`, kind: 'extension-action' })
      continue
    }
    if (item.kind === 'compaction') {
      if (projectConversationCompactionState(item.status, item.errorCode) === 'not_needed')
        continue
      rows.push({
        compaction: item,
        key: `compaction:${item.id}`,
        kind: 'compaction',
      })
      continue
    }
    if (processMessageIds.has(item.id))
      continue
    const ownsResult = isFinalTurnMessage(item, turnsByRunId) && item.runId
      && !['queued', 'running'].includes(turnsByRunId.get(item.runId)!.status)
    const turnOutputs = ownsResult && item.runId
      ? outputsByRunId.get(item.runId) ?? null
      : null
    const turnChanges = ownsResult && item.runId
      ? changesByRunId.get(item.runId) ?? null
      : null
    if (!isVisibleChatMessage(item) && turnOutputs === null && turnChanges === null)
      continue
    const row: ChatTranscriptMessageRow = {
      ...(item.role === 'assistant' && item.runId && turnsByRunId.has(item.runId) && !ownsResult ? { isIntermediate: true as const } : {}),
      key: `message:${item.id}`,
      kind: 'message',
      message: item,
      turnOutputs,
    }
    if (ownsResult && item.runId)
      row.resultRunId = item.runId
    if (turnChanges)
      row.turnChanges = turnChanges
    const turnUsage = ownsResult && item.runId
      ? turnsByRunId.get(item.runId)?.usage
      : null
    if (turnUsage)
      row.turnUsage = turnUsage
    rows.push(row)
    rows.push(...(turnsByTrigger.get(item.id) ?? []).map((turn) => {
      const ownsResultActions = (
        turn.status === 'failed'
        || turn.status === 'cancelled'
      ) && !renderedResultRunIds.has(turn.runId)
      return {
        ...(ownsResultActions ? { ownsResultActions: true as const } : {}),
        key: `agent-turn:${turn.runId}`,
        kind: 'agent-turn' as const,
        turn,
      }
    }))
  }
  return interleaveChatTranscriptSegments(rows, new Map(turns.flatMap(turn => Object.entries(turn.messageStartedAt ?? {}))))
}

export function isVisibleExtensionAction(item: LocalConversationTimelineItem): item is ExtensionActionTimelineItem {
  return item.kind === 'extension-action'
    && (item.status !== 'skipped' || item.trigger === 'user')
}

function isFinalTurnMessage(
  message: LocalMessage,
  turnsByRunId: ReadonlyMap<string, ChatAgentTurn>,
): boolean {
  if (message.role !== 'assistant' || !message.runId)
    return false
  const turn = turnsByRunId.get(message.runId)
  if (!turn)
    return false
  return turn.finalMessageId === message.id
}

function projectTurnOutputs(
  outputs: ReadonlyArray<LocalRunOutput>,
): ReadonlyMap<string, ChatTranscriptTurnOutputs> {
  const artifactsByRunId = new Map<string, LocalArtifact[]>()
  const artifactIdsByRunId = new Map<string, Set<string>>()
  for (const output of outputs) {
    const artifacts = artifactsByRunId.get(output.runId) ?? []
    const artifactIds = artifactIdsByRunId.get(output.runId) ?? new Set<string>()
    for (const artifact of output.artifacts) {
      if (artifactIds.has(artifact.artifactId)) {
        artifacts[artifacts.findIndex(item => item.artifactId === artifact.artifactId)] = artifact
      }
      else {
        artifactIds.add(artifact.artifactId)
        artifacts.push(artifact)
      }
    }
    artifactsByRunId.set(output.runId, artifacts)
    artifactIdsByRunId.set(output.runId, artifactIds)
  }
  return new Map([...artifactsByRunId].map(([runId, artifacts]) => [
    runId,
    { artifacts, runId },
  ]))
}

export function shouldShowAgentTurn(turn: ChatAgentTurn): boolean {
  return turn.nodes.length > 0
    || turn.status === 'queued'
    || turn.status === 'running'
    || turn.status === 'failed'
    || turn.status === 'cancelled'
}
