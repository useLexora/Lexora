import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalConversationTimelineItem, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalExecutionInputReceipt } from '@buddy-shared/executions/executionInputReceipt'
import type { LocalRun, LocalRunEvent, LocalRunOutput } from '@buddy-shared/runs/runApi'
import type { LocalRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'

import type { ExecutionGroups } from '../executions/executionGroups'
import type { ChatAgentToolNode, ChatAgentTurn } from './chatAgentTurn'
import type { ChatRecoveryNotice } from './chatRunRecovery'
import type { ChatRunTranscriptProjection } from './chatRunTranscriptProjector'

export interface ChatTranscriptMessageRow {
  executionStatus?: ChatTranscriptExecutionStatus
  endsSpeech?: true
  isIntermediate?: true
  showActions?: false
  actionMessages?: readonly LocalMessage[]
  processRunId?: string
  showIdentity?: false
  resultRunId?: string
  ownsResultActions?: true
  key: string
  kind: 'message'
  message: LocalMessage
  streaming?: true
  turnChanges?: LocalChangeSetSummary
  turnUsage?: LocalRunTokenUsage
  turnResult?: ChatAgentTurn
  turnOutputs: ChatTranscriptTurnOutputs | null
}

export interface ChatTranscriptTurnOutputs {
  artifacts: ReadonlyArray<LocalArtifact>
  runId: string
}

export interface ChatTranscriptExecutionInputRow {
  key: string
  kind: 'execution-input'
  input: LocalExecutionInputReceipt
}

export interface ChatTranscriptCompactionRow {
  compaction: Extract<LocalConversationTimelineItem, { kind: 'compaction' }>
  key: string
  kind: 'compaction'
}

export interface ChatTranscriptExtensionActionRow {
  action: Extract<LocalConversationTimelineItem, { kind: 'extension-action' }>
  key: string
  kind: 'extension-action'
}

export interface ChatTranscriptActivityFlowRow {
  createdAt: string
  key: string
  kind: 'activity-flow'
  nodes: ReadonlyArray<ChatAgentToolNode>
}

export interface ChatTranscriptAgentTurnRow {
  executionStatus?: ChatTranscriptExecutionStatus
  endsSpeech?: true
  showIdentity?: false
  showOutcome?: false
  key: string
  kind: 'agent-turn'
  ownsResultActions?: true
  turn: ChatAgentTurn
}

export type ChatTranscriptExecutionStatus = Pick<ChatAgentTurn, 'status' | 'startedAt' | 'completedAt'>

export interface ChatTranscriptActivityRow {
  key: string
  kind: 'activity'
  turn: ChatAgentTurn
}

export interface ChatTranscriptTurnResultRow {
  key: string
  kind: 'turn-result'
  turn: ChatAgentTurn
}

export interface ChatTranscriptRecoveryNoticeRow {
  key: string
  kind: 'recovery-notice'
  notice: ChatRecoveryNotice
}

export type ChatTranscriptRow
  = | ChatTranscriptActivityRow
    | ChatTranscriptAgentTurnRow
    | ChatTranscriptCompactionRow
    | ChatTranscriptActivityFlowRow
    | ChatTranscriptMessageRow
    | ChatTranscriptExecutionInputRow
    | ChatTranscriptRecoveryNoticeRow
    | ChatTranscriptTurnResultRow

export interface ChatTranscriptProjection {
  rows: ReadonlyArray<ChatTranscriptRow>
  update: ChatTranscriptProjectionUpdate
}

export interface ChatTranscriptRowPatch {
  deleteCount: 0 | 1
  index: number
  rows: ReadonlyArray<ChatTranscriptRow>
}

export type ChatTranscriptProjectionUpdate
  = | { kind: 'replace' }
    | {
      kind: 'patch'
      patches: ReadonlyArray<ChatTranscriptRowPatch>
      previousRows: ReadonlyArray<ChatTranscriptRow>
    }

export interface ChatTranscriptProjectionInput {
  executionGroups?: ExecutionGroups
  executionInputs?: readonly LocalExecutionInputReceipt[]
  includeUnanchoredTurns?: boolean
  agentTurns?: ReadonlyArray<ChatAgentTurn>
  changeSets?: ReadonlyArray<LocalChangeSetSummary>
  outputs: ReadonlyArray<LocalRunOutput>
  runEvents?: ReadonlyArray<LocalRunEvent>
  runProjections?: ReadonlyArray<ChatRunTranscriptProjection>
  runs: ReadonlyArray<LocalRun>
  timelineItems: ReadonlyArray<LocalConversationTimelineItem>
}
