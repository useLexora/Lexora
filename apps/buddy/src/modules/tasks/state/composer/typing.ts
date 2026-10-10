import type { BuddyComposerResource, BuddyComposerSource, BuddySpaceFileSource } from '@buddy-shared/conversation/composerResource'
import type { Ref } from 'vue'
import type { BuddyI18nKey } from '@/i18n/buddyI18n'

export interface ComposerResourceView {
  readonly accepted: boolean
  readonly canRetry: boolean
  readonly resource: BuddyComposerResource
}

export interface ChatComposerNoticeInteraction {
  autoDismissMs: number | null
  dismissible: boolean
  id: string
  kind: 'notice'
  messageKey: BuddyI18nKey
  tone: 'info' | 'warning'
}

export type ChatComposerInteraction = ChatComposerNoticeInteraction

export interface ComposerResourcesState {
  dispose: () => void
  begin: (files: readonly File[], origin?: 'file' | 'clipboard') => readonly string[]
  importText: (text: string) => Promise<string | null>
  readText: (resourceId: string) => Promise<string>
  rejectedIds: ReadonlySet<string>
  resources: Readonly<Ref<readonly ComposerResourceView[]>>
  retry: (resourceId: string) => Promise<void>
  restore: (draftId: string) => Promise<void>
  selectFiles: (draftId: string) => Promise<string[]>
  selectSource: (source: BuddyComposerSource, draftId?: string) => Promise<string | null>
  selectSpaceFile: (source: BuddySpaceFileSource, draftId?: string) => Promise<string | null>
  whenAccepted: () => Promise<void>
}
