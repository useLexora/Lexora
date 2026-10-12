import type { BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { BuddyExecutionProfile } from '@buddy-shared/permissions/executionProfile'

export type AutomationCalendarCadence = 'daily' | 'weekly' | 'monthly' | 'yearly'
export type AutomationFrequencyMode = 'calendar' | 'interval' | 'once'

export interface AutomationScheduleForm {
  activeFrom: string | null
  activeUntil: string | null
  anchorLocal: string | null
  cadence: AutomationCalendarCadence
  day: number
  dayOfMonth: number | 'last'
  every: number
  frequencyMode: AutomationFrequencyMode
  intervalUnit: 'hour' | 'day'
  localTime: string | null
  month: number
  onceLocal: string | null
  timezone: string
  weekdays: number[]
}

export interface AutomationEditorForm extends AutomationScheduleForm {
  actorId: string | null
  executionProfile: BuddyExecutionProfile
  modelMode: 'default' | 'pinned'
  name: string
  pinnedModelKey: string | null
  spaceId: string | null
  prompt: string
  reasoning: BuddyThinkingLevel | null
}
