import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { TaskChatWorkspace, TaskComposer, TaskDraftRestoration, TaskExecution, TaskStatus } from '../../contracts'
import type { ChatReadingPositions } from '../transcript/chatMessageViewport'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopSettingsCategory } from '@/shared/navigation/desktopRoutes'

export interface ChatWorkspaceProps {
  active?: boolean
  readingPositions?: ChatReadingPositions
  viewMode?: 'chat' | 'canvas'
  revealMessageId: string | null
  workspace: TaskChatWorkspace
}

export interface ChatWorkspaceEmits {
  ready: []
  showCanvas: []
  openNodeArtifact: [artifact: LocalArtifact]
  openNodeChanges: [changes: LocalChangeSetSummary]
  openArtifact: [artifactId: string]
  openChanges: [changeSetId: string]
  openSettings: [category: DesktopSettingsCategory]
}

export interface TaskComposerHostProps {
  skillScopeId?: string | null
  composer: TaskComposer
  focusReady: boolean
  execution: Pick<TaskExecution, 'activeRun' | 'canSend' | 'editingMessageId' | 'isMutatingBranch' | 'isSending' | 'cancelActiveRun' | 'send' | 'submitEditedMessage' | 'queuedMessages' | 'pendingQueueActions' | 'cancelQueuedMessage' | 'steerQueuedMessage'>
  language: BuddyLocale
}

export interface TaskNoticesProps {
  execution: Pick<TaskExecution, 'approvalViews' | 'editingMessageId' | 'resolvingApprovalActions' | 'cancelEditUserMessage' | 'resolveApproval'>
  language: BuddyLocale
  restoration: TaskDraftRestoration
  status: TaskStatus
}
