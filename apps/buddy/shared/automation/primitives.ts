import { z } from 'zod'

export const AUTOMATION_LIFECYCLE_STATUSES = [
  'active',
  'paused',
  'blocked',
  'completed',
] as const

export const AUTOMATION_OCCURRENCE_STATUSES = [
  'queued',
  'bound',
  'skipped',
  'expired',
  'cancelled',
] as const

export const AUTOMATION_TRIGGER_KINDS = ['scheduled', 'manual'] as const

export const AUTOMATION_BLOCKED_REASONS = [
  'AUTOMATION_SPACE_UNAVAILABLE',
  'AUTOMATION_PINNED_MODEL_UNAVAILABLE',
] as const

export const AUTOMATION_ERROR_CODES = [
  'AUTOMATION_CONFLICT',
  'AUTOMATION_NOT_FOUND',
  'AUTOMATION_INVALID_SCHEDULE',
  'AUTOMATION_SPACE_UNAVAILABLE',
  'AUTOMATION_PINNED_MODEL_UNAVAILABLE',
  'AUTOMATION_DEFAULT_MODEL_UNAVAILABLE',
  'AUTOMATION_ACTOR_UNAVAILABLE',
  'AUTOMATION_APPROVAL_EXPIRED',
  'AUTOMATION_RUN_TIMEOUT',
  'OVERLAP_SKIPPED',
  'MISSED_WINDOW_EXCEEDED',
  'DATA_RESTORE_SKIPPED',
  'RUNTIME_RESTARTED',
] as const

export const AUTOMATION_EFFECTIVE_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'expired',
] as const

export const AUTOMATION_PREVIEW_SAMPLE_LIMIT = 5

export const AUTOMATION_EXECUTION_SNAPSHOT_MAX_BYTES = 48 * 1024

export const AUTOMATION_PROMPT_MAX_BYTES = 32 * 1024

export const idSchema = z.string().trim().min(1).max(256)

export const utcInstantSchema = z.iso.datetime()

export const automationNameSchema = z.string().trim().refine(
  value => unicodeLength(value) >= 1 && unicodeLength(value) <= 80,
)

export const automationLifecycleStatusSchema = z.enum(AUTOMATION_LIFECYCLE_STATUSES)

export const automationOccurrenceStatusSchema = z.enum(AUTOMATION_OCCURRENCE_STATUSES)

export const automationTriggerKindSchema = z.enum(AUTOMATION_TRIGGER_KINDS)

export const automationErrorCodeSchema = z.enum(AUTOMATION_ERROR_CODES)

export const automationBlockedReasonSchema = z.enum(AUTOMATION_BLOCKED_REASONS)

export const automationEffectiveStatusSchema = z.enum(AUTOMATION_EFFECTIVE_STATUSES)

export type AutomationEffectiveStatus = z.infer<typeof automationEffectiveStatusSchema>

export type AutomationErrorCode = z.infer<typeof automationErrorCodeSchema>

export type AutomationBlockedReason = z.infer<typeof automationBlockedReasonSchema>

export function unicodeLength(value: string): number {
  return Array.from(value).length
}
