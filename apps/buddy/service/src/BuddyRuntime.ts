import type { LocalStartTurnRequest } from '../../shared/conversation/chatApi'
import type { SkillReference } from '../../shared/skills/skillApi'
import type { toPublicRun } from './runs/publicRun'

export interface BuddyTurnContextItem {
  skill?: SkillReference
  kind: 'file' | 'skill' | 'slashCommand'
  value: string
}

export type BuddyStartTurnInput = LocalStartTurnRequest

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
