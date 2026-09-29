import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalTurnStart } from '@buddy-shared/conversation/chatApi'
import type { LocalConversationTimelineItem, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalApproval } from '@buddy-shared/permissions/approvalApi'
import type { LocalRun, LocalRunEvent, LocalRunOutput } from '@buddy-shared/runs/runApi'
import type { Ref } from 'vue'
import type { ChatRunEventBuckets } from '../../model/runs/typing'

export interface ChatRunSyncOptions {
  activeBranchId: Readonly<Ref<string | null>>
  activeConversationId: Readonly<Ref<string | null>>
  api: {
    approvals: Pick<LocalChatApi['approvals'], 'list'>
    conversations: Pick<LocalChatApi['conversations'], 'listTimeline'>
  }
  onError: (error: unknown) => void
}

export interface ChatRunProjectionState {
  approvals: Readonly<Ref<ReadonlyArray<LocalApproval>>>
  changeSets: Readonly<Ref<ReadonlyArray<LocalChangeSetSummary>>>
  hasOlderMessages: Readonly<Ref<boolean>>
  messages: Readonly<Ref<ReadonlyArray<LocalMessage>>>
  runEventBuckets: Readonly<Ref<ChatRunEventBuckets>>
  runOutputs: Readonly<Ref<ReadonlyArray<LocalRunOutput>>>
  runs: Readonly<Ref<ReadonlyArray<LocalRun>>>
  runSignalEvents: Readonly<Ref<ReadonlyArray<LocalRunEvent>>>
  timelineItems: Readonly<Ref<ReadonlyArray<LocalConversationTimelineItem>>>
}

export interface ChatRunSync extends ChatRunProjectionState {
  executionRuns: Readonly<Ref<ReadonlyArray<LocalRun>>>
  cancelRunPresentation: (runId: string) => void
  restoreRunPresentation: (runId: string) => void
  isLoadingConversation: Readonly<Ref<boolean>>
  isLoadingOlderMessages: Readonly<Ref<boolean>>
  applyEditedTurn: (turn: LocalTurnStart, userMessageId: string) => void
  applyRegeneratedTurn: (turn: LocalTurnStart) => void
  applyRunStart: (turn: LocalTurnStart) => void
  clearConversationState: () => void
  dispose: () => void
  handleRunEvent: (event: LocalRunEvent) => void
  loadOlderMessages: () => Promise<boolean>
  refreshActiveConversation: () => Promise<void>
  upsertRuns: (incoming: ReadonlyArray<LocalRun>) => void
}
