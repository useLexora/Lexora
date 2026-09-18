import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { LocalTurnStart } from '@buddy-shared/conversation/chatApi'
import type { BuddyComposerDraft as LocalComposerDraft } from '@buddy-shared/conversation/composerDraft'
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { BuddyServiceTier, BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { BuddyPermissionSettings } from '@buddy-shared/permissions/permissionMode'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { JSONContent } from '@tiptap/core'
import type { ComputedRef, Ref } from 'vue'

export interface ChatDraftState {
  approvalPolicy: LocalComposerDraft['executionConfig']['approvalPolicy']
  confirmedSnapshot: string | null
  content: BuddyUserContentV1
  draftId: string
  editorSessionId: string
  editVersion: number
  executionProfile: LocalComposerDraft['executionConfig']['executionProfile']
  modelSelection: LocalComposerDraft['modelSelection']
  revision: number | null
}

export interface ChatDraftSnapshot extends ChatDraftState {
  targetKey: string
}

export type ComposerDraftReceipt = NonNullable<LocalTurnStart['draftReceipt']>

export interface ChatDrafts {
  approvalPolicy: ComputedRef<ChatDraftState['approvalPolicy']>
  composerContent: ComputedRef<JSONContent>
  draft: ComputedRef<string>
  draftId: ComputedRef<string>
  editorKey: ComputedRef<string>
  executionProfile: ComputedRef<ChatDraftState['executionProfile']>
  modelSelection: ComputedRef<ChatDraftState['modelSelection']>
  targetKey: ComputedRef<string>
  acknowledgeSend: (receipt: ComposerDraftReceipt, targetKey: string) => boolean
  appendResourcePanel: (draftId: string, resourceIds: readonly string[], editorSessionId?: string) => void
  beginIsolated: (targetKey: string, content: BuddyUserContentV1) => boolean
  resumeIsolated: (targetKey: string) => void
  cancelIsolated: (targetKey: string) => boolean
  completeIsolated: (receipt: ComposerDraftReceipt, targetKey: string, sourceKey: string) => boolean
  confirmOpen: (submitted: ChatDraftSnapshot, remote: LocalComposerDraft, preserveLocalContent?: boolean) => boolean
  confirmSave: (submitted: ChatDraftSnapshot, remote: LocalComposerDraft) => boolean
  discard: (targetKey: string) => Promise<void>
  discardConversation: (conversationId: string) => Promise<void>
  hydrate: (values: ReadonlyArray<{ draft: LocalComposerDraft, targetKey: string }>) => void
  isEditorSessionCurrent: (value: Pick<ChatDraftState, 'draftId' | 'editorSessionId'>) => boolean
  isPersisted: (value: ChatDraftSnapshot) => boolean
  isUnchanged: (value: ChatDraftSnapshot) => boolean
  listSnapshots: () => ChatDraftSnapshot[]
  load: (targetKey: string) => ChatDraftState
  rejectResources: (draftId: string, resourceIds: readonly string[]) => void
  resourceIdsForDraft: (draftId: string) => string[]
  setModelSelection: (modelSelection: LocalComposerDraft['modelSelection']) => void
  setPermissionSettings: (settings: BuddyPermissionSettings, targetKey?: string) => void
  setUserContent: (content: BuddyUserContentV1) => void
  snapshot: (targetKey: string) => ChatDraftSnapshot
  updateComposerContent: (text: string, value: JSONContent | null) => void
}

export type DraftRestorationState = 'pending' | 'restoring' | 'ready' | 'failed' | 'conflict'

export interface DraftRestorationConflict {
  targetKey: string
  local: ChatDraftSnapshot
  remote: LocalComposerDraft
}

export interface TaskModelSelection {
  selectedEffort: Readonly<Ref<BuddyThinkingLevel | null>>
  selectedModel: Readonly<Ref<LocalRuntimeModelOption | null>>
  selectedModelOption: Readonly<Ref<LocalRuntimeModelOption | null>>
  selectedModelId: Readonly<Ref<string | null>>
  selectedServiceTier: Readonly<Ref<BuddyServiceTier | null>>
  restoreConversationModelSelection: (value: LocalConversation['modelSelection']) => void
  selectDefaultModel: () => void
  selectModel: (value: string) => Promise<boolean>
  setSelectedEffort: (value: BuddyThinkingLevel | null) => Promise<boolean>
  setSelectedServiceTier: (value: BuddyServiceTier | null) => void
  currentSelection: () => LocalConversation['modelSelection']
  dispose: () => void
}
