import type { InjectionKey, Ref } from 'vue'
import type { ConversationCanvasDirection, ConversationCanvasNode } from '../../model/canvas/conversationCanvasLayout'
import type { BuddyLocale } from '@/i18n/buddyI18n'

export interface ConversationCanvasData {
  message: ConversationCanvasNode
  direction: ConversationCanvasDirection
  canMutate: boolean
}

export const conversationCanvasActions: InjectionKey<{
  language: Readonly<Ref<BuddyLocale>>
  active: Readonly<Ref<boolean>>
  selectedNodeId: Readonly<Ref<string | null>>
  open: (id: string) => void
  edit: (id: string) => void
  followup: (id: string) => void
  retry: (id: string) => void
  openArtifact: (id: string) => void
  openQuote: (messageId: string, quoteId: string) => void
}> = Symbol('conversationCanvasActions')
