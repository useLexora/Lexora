import type { BuddySessionReference } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyComposerSource } from '@buddy-shared/conversation/composerResource'
import type { BuddyServiceTier, BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { BuddyPermissionMode } from '@buddy-shared/permissions/permissionMode'
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { JSONContent } from '@tiptap/core'
import type { Ref } from 'vue'
import type { ChatContextUsage } from '../../model/runs/typing'
import type { ChatComposerInteraction, ComposerResourceView } from '../../state/composer/typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ChatComposerContextOptions, ChatComposerSubmitPayload, ChatComposerTrigger } from '@/modules/prompt-input'

export interface ComposerResourceCard extends ComposerResourceView {
  imageLabel?: string
  previewUrl: string | null
}

export interface UseChatComposerOptions {
  canSend: Readonly<Ref<boolean>>
  composerContent: Readonly<Ref<JSONContent>>
  draft: Readonly<Ref<string>>
  draftId: Readonly<Ref<string>>
  resources: Readonly<Ref<readonly ComposerResourceView[]>>
  rejectedResourceIds: () => ReadonlySet<string>
  isRunning: Readonly<Ref<boolean>>
  isSending: Readonly<Ref<boolean>>
  language: Readonly<Ref<BuddyLocale>>
  selectedModel: Readonly<Ref<LocalRuntimeModelOption | null>>
  selectedEffort: Readonly<Ref<BuddyThinkingLevel | null>>
  selectedServiceTier: Readonly<Ref<BuddyServiceTier | null>>
  loadContextOptions: (fileQuery: string | null, deepSearch?: boolean) => Promise<ChatComposerContextOptions>
  beginImport: (files: readonly File[], origin?: 'file' | 'clipboard') => readonly string[]
  selectSource: (source: BuddyComposerSource) => Promise<string | null>
  onSend: (payload: ChatComposerSubmitPayload) => void
  onUpdateContent: (content: string, value: JSONContent) => void
  onLocateResource?: (resourceId: string) => void
}

export interface ChatComposerEditorOptions {
  composerContent: Readonly<Ref<JSONContent>>
  draft: Readonly<Ref<string>>
  draftId: Readonly<Ref<string>>
  isSending: Readonly<Ref<boolean>>
  language: Readonly<Ref<BuddyLocale>>
  rejectedResourceIds: () => ReadonlySet<string>
  resources: Readonly<Ref<readonly ComposerResourceView[]>>
  onUpdateContent: (content: string, value: JSONContent) => void
  onTrigger: (trigger: ChatComposerTrigger | null) => void
  onSuggestionKeydown: (event: KeyboardEvent) => boolean
  onPasteFiles: (files: readonly File[]) => void
  onPasteSessionReferences: (references: readonly BuddySessionReference[], text: string) => void
  onSubmit: () => void
  onLocateResource?: (resourceId: string) => void
}

export interface DesktopChatComposerProps {
  manageSkills?: () => void
  hasQueuedMessages?: boolean
  canUpdatePermissionSettings: boolean
  canSend: boolean
  composerContent: JSONContent
  contextUsage: ChatContextUsage | null
  draft: string
  draftId: string
  resources: readonly ComposerResourceView[]
  rejectedResourceIds: ReadonlySet<string>
  beginImport: (files: readonly File[], origin?: 'file' | 'clipboard') => readonly string[]
  selectSource: (source: BuddyComposerSource) => Promise<string | null>
  isRunning: boolean
  isSelectingFiles: boolean
  isSending: boolean
  isUpdatingPermissionSettings: boolean
  interaction: ChatComposerInteraction | null
  language: BuddyLocale
  loadContextOptions: (fileQuery: string | null, deepSearch?: boolean) => Promise<ChatComposerContextOptions>
  models: ReadonlyArray<LocalRuntimeModelOption>
  permissionMode: BuddyPermissionMode
  providers: ReadonlyArray<LocalProvider>
  selectedEffort: BuddyThinkingLevel | null
  selectedModel: LocalRuntimeModelOption | null
  selectedModelId: string | null
  selectedServiceTier: BuddyServiceTier | null
}
