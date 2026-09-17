import type { DesktopChatWelcomePreference, DesktopTaskPinnedItem, DesktopTaskSidebarSection } from '@buddy-electron/shared/desktopApi'
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalChatQueueItem } from '@buddy-shared/conversation/chatQueueApi'
import type { BuddyComposerDraftScope } from '@buddy-shared/conversation/composerDraft'
import type { BuddyComposerSource } from '@buddy-shared/conversation/composerResource'
import type { LocalConversation, LocalConversationBranch, LocalConversationSummary, LocalConversationTimelineItem, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalConversationTree } from '@buddy-shared/conversation/conversationTree'
import type { BuddyServiceTier, BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { LocalTaskMark, LocalTaskMarkState, TaskMarkInput } from '@buddy-shared/conversation/taskMarkApi'
import type { LocalApproval } from '@buddy-shared/permissions/approvalApi'
import type { BuddyPermissionMode } from '@buddy-shared/permissions/permissionMode'
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { LocalRun, LocalRunEvent, LocalRunOutput } from '@buddy-shared/runs/runApi'
import type { LocalBuddyServiceSupervisorState } from '@buddy-shared/runtime/serviceState'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { JSONContent } from '@tiptap/core'
import type { DeepReadonly, Ref } from 'vue'
import type { ChatApprovalDecision, ChatContextUsage, ChatRunEventBuckets } from './model/runs/typing'
import type { ChatBlocker } from './model/status/typing'
import type { ChatComposerInteraction, ComposerResourceView } from './state/composer/typing'
import type { DraftRestorationConflict, DraftRestorationState } from './state/drafts/typing'
import type { TaskSpaceInput } from './state/task-index/typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ChatComposerContextOptions, ChatComposerSubmitPayload } from '@/modules/prompt-input'

type State<T> = Readonly<Ref<DeepReadonly<T>>>

export interface TaskMarks {
  items: State<readonly LocalTaskMark[]>
  states: State<ReadonlyMap<string, LocalTaskMarkState>>
  busy: State<boolean>
  loading: State<boolean>
  error: State<string | null>
  refresh: () => Promise<void>
  save: (input: TaskMarkInput, id?: string) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  assign: (conversationId: string, markId: string | null) => Promise<boolean>
  clear: (conversationId: string) => Promise<boolean>
  setRead: (conversationId: string, read: boolean) => Promise<boolean>
  readResult: (conversationId: string, resultRunId: string, readRevision: number) => Promise<void>
  beginVisit: (conversationId: string) => void
}

export interface TaskIndex {
  marks: TaskMarks
  pinnedItems: State<readonly DesktopTaskPinnedItem[]>
  setPinnedItems: (items: DesktopTaskPinnedItem[]) => Promise<boolean>
  sidebar: {
    collapsed: State<boolean>
    collapsedSections: State<ReadonlySet<DesktopTaskSidebarSection>>
    collapsedSpaceIds: State<ReadonlySet<string>>
    scrollAnchors: State<Readonly<Record<DesktopTaskSidebarSection, number>>>
    width: State<number | null>
    pruneSpaces: (validSpaceIds: ReadonlySet<string>) => void
    recordScrollAnchor: (section: DesktopTaskSidebarSection, index: number) => void
    setCollapsed: (collapsed: boolean) => Promise<boolean>
    setSectionExpanded: (section: DesktopTaskSidebarSection, expanded: boolean) => Promise<boolean>
    setSpaceExpanded: (spaceId: string, expanded: boolean) => Promise<boolean>
    setWidth: (width: number | null) => Promise<boolean>
  }
  spaces: State<readonly LocalSpace[]>
  tasks: State<readonly LocalConversationSummary[]>
  createSpace: (input: TaskSpaceInput) => Promise<boolean>
  updateSpace: (input: TaskSpaceInput & { spaceId: string }) => Promise<boolean>
  deleteSpace: (spaceId: string) => Promise<boolean>
  deleteTask: (taskId: string) => Promise<void>
  renameTask: (taskId: string, title: string) => Promise<boolean>
  selectSpaceDirectory: () => Promise<string | null>
  openSpaceDirectory: (spaceId: string) => Promise<boolean>
  refresh: () => Promise<void>
}

export interface TaskSession {
  navigationVersion: () => number
  activeSpace: State<LocalSpace | null>
  activeTask: State<LocalConversation | null>
  activeTaskId: State<string | null>
  currentTitle: State<string>
  spaceId: State<string | null>
  openTask: (taskId: string, signal?: AbortSignal) => Promise<void>
  startTask: (spaceId: string | null) => Promise<void>
}

export interface TaskWorkspaceSession {
  activeBranchId: State<string | null>
  activeConversation: State<LocalConversation | null>
  activeConversationId: State<string | null>
  activeSpace: State<LocalSpace | null>
  currentTitle: State<string>
  spaceId: State<string | null>
  listActiveConversationMessages: () => Promise<readonly LocalMessage[]>
  openConversation: (conversationId: string) => Promise<void>
}

export interface TaskComposer {
  target: State<BuddyComposerDraftScope>
  composerContent: Readonly<Ref<JSONContent>>
  contextUsage: State<ChatContextUsage | null>
  draft: State<string>
  draftId: State<string>
  editorKey: State<string>
  resources: Readonly<Ref<readonly ComposerResourceView[]>>
  rejectedResourceIds: ReadonlySet<string>
  canUpdatePermissionSettings: State<boolean>
  isUpdatingPermissionSettings: State<boolean>
  isSelectingFiles: State<boolean>
  interaction: State<ChatComposerInteraction | null>
  models: State<readonly LocalRuntimeModelOption[]>
  providers: State<readonly LocalProvider[]>
  selectedEffort: State<BuddyThinkingLevel | null>
  selectedModel: State<LocalRuntimeModelOption | null>
  selectedModelId: State<string | null>
  selectedServiceTier: State<BuddyServiceTier | null>
  permissionMode: State<BuddyPermissionMode>
  beginImport: (files: readonly File[], origin?: 'file' | 'clipboard') => readonly string[]
  dismissInteraction: (id: string) => void
  listContextOptions: (fileQuery: string | null, deepSearch?: boolean) => Promise<ChatComposerContextOptions>
  retryResource: (resourceId: string) => Promise<void>
  selectAttachments: () => Promise<void>
  selectModel: (modelId: string) => Promise<void>
  selectSource: (source: BuddyComposerSource, draftId?: string) => Promise<string | null>
  setSelectedEffort: (effort: BuddyThinkingLevel | null) => Promise<void>
  setSelectedServiceTier: (tier: BuddyServiceTier | null) => Promise<void>
  setPermissionMode: (mode: BuddyPermissionMode) => Promise<boolean>
  updateComposerContent: (text: string, content: JSONContent | null) => void
}

export interface TaskExecution {
  queuedMessages: State<readonly LocalChatQueueItem[]>
  pendingQueueActions: State<ReadonlySet<string>>
  cancelQueuedMessage: (id: string) => Promise<void>
  steerQueuedMessage: (id: string) => Promise<void>
  beginFollowup: (target: Extract<BuddyComposerDraftScope, { kind: 'message_followup' }>) => Promise<boolean>
  cancelFollowup: () => void
  activeRun: State<LocalRun | null>
  approvalViews: State<readonly LocalApproval[]>
  canMutateBranch: State<boolean>
  canSend: State<boolean>
  editingMessageId: State<string | null>
  isMutatingBranch: State<boolean>
  isSending: State<boolean>
  resolvingApprovalActions: State<ReadonlyMap<string, ChatApprovalDecision>>
  resolvingApprovalIds: State<ReadonlySet<string>>
  cancelActiveRun: () => Promise<void>
  cancelEditUserMessage: () => void
  editUserMessage: (messageId: string, sourceBranchId?: string) => Promise<boolean>
  regenerateAssistant: (runId: string) => Promise<boolean>
  resolveApproval: (approvalId: string, decision: ChatApprovalDecision) => Promise<void>
  send: (payload: ChatComposerSubmitPayload | string) => Promise<boolean>
  submitEditedMessage: (payload: ChatComposerSubmitPayload) => Promise<boolean>
}

export interface TaskTranscript {
  branches: State<readonly LocalConversationBranch[]>
  changeSets: State<readonly LocalChangeSetSummary[]>
  hasOlderMessages: State<boolean>
  isLoadingOlderMessages: State<boolean>
  messages: State<readonly LocalMessage[]>
  runEventBuckets: State<ChatRunEventBuckets>
  runSignalEvents: State<readonly LocalRunEvent[]>
  runOutputs: State<readonly LocalRunOutput[]>
  runs: State<readonly LocalRun[]>
  timelineItems: State<readonly LocalConversationTimelineItem[]>
  activateBranch: (branchId: string) => Promise<boolean>
  loadOlderMessages: () => Promise<boolean>
}

export interface TaskStatus {
  canRestartRuntime: State<boolean>
  errorMessage: State<string | null>
  isLoading: State<boolean>
  runtimeError: State<string | null>
  runtimeState: State<LocalBuddyServiceSupervisorState>
  visibleChatBlocker: State<ChatBlocker | null>
  dismissChatBlocker: () => void
  dismissError: () => void
  restartRuntime: () => Promise<boolean>
}

export interface TaskDraftRestoration {
  state: State<DraftRestorationState>
  conflict: State<DraftRestorationConflict | null>
  restore: () => Promise<void>
  resolveRemote: (targetKey: string) => Promise<boolean>
}

export interface TaskConversationTree {
  data: State<LocalConversationTree | null>
  loading: State<boolean>
  error: State<string | null>
  refresh: () => Promise<void>
  setVisible: (value: boolean) => void
}

export interface TaskChatWorkspace {
  marks: TaskMarks
  tree: TaskConversationTree
  restoration: TaskDraftRestoration
  context: {
    getChangeOverview: LocalChatApi['changes']['overview']
    files: Pick<LocalChatApi['spaces'], 'listDirectory' | 'readFile' | 'revealFile'>
    getNodeDetail: LocalChatApi['conversations']['getNodeDetail']
    getChangeSet: LocalChatApi['changes']['get']
    readArtifactText: LocalChatApi['artifacts']['readText']
  }
  composer: TaskComposer
  execution: TaskExecution
  language: State<BuddyLocale>
  session: TaskWorkspaceSession
  welcomePreference: State<DesktopChatWelcomePreference>
  status: TaskStatus
  transcript: TaskTranscript
}

export interface TaskCapability {
  index: TaskIndex
  language: State<BuddyLocale>
  session: TaskSession
  workspace: TaskChatWorkspace
  initialize: () => Promise<void>
  refreshRuntimeDependentState: () => Promise<void>
  flushDrafts: () => Promise<boolean>
  dispose: () => void
}
export type { TaskResourcePanel } from './state/context-panel/useTaskResourcePanel'
