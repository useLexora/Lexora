import type { BuddyComposerDraftSend } from '../../shared/conversation/composerDraft'
import type { SkillReference } from '../../shared/skills/skillApi'
import type { toPublicRun } from './runs/publicRun'

export interface BuddyTurnContextItem {
  title?: string
  skill?: SkillReference
  kind: 'file' | 'skill' | 'slashCommand' | 'sessionReference'
  value: string
}

export type BuddyStartTurnInput = BuddyComposerDraftSend

export interface BuddyTurnStart {
  branchId: string
  conversationId: string
  draftReceipt: {
    committedRevision: number
    draftId: string
    sourceRevision: number
  } | null
  run: ReturnType<typeof toPublicRun>
  runId: string
}

export interface BuddyRuntime {
  startTurn: (input: BuddyStartTurnInput) => Promise<BuddyTurnStart>
}
