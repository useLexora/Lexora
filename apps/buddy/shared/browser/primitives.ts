import { z } from 'zod'

export const BROWSER_ERROR_CODES = [
  'BROWSER_CERTIFICATE_ERROR',
  'BROWSER_CONTROL_REQUIRED',
  'BROWSER_DIALOG_PENDING',
  'BROWSER_HUMAN_INPUT_REQUIRED',
  'BROWSER_IN_USE',
  'BROWSER_NAVIGATION_BLOCKED',
  'BROWSER_PAGE_CRASHED',
  'BROWSER_PAGE_FAILED',
  'BROWSER_PAGE_UNRESPONSIVE',
  'BROWSER_PERMISSION_DENIED',
  'BROWSER_SESSION_EVICTED',
  'BROWSER_SESSION_LIMIT_REACHED',
  'BROWSER_SESSION_NOT_FOUND',
  'BROWSER_TARGET_STALE',
] as const

export const BROWSER_RECOVERY_ACTIONS = [
  'read_again',
  'open_again',
  'request_human_control',
] as const

export const BROWSER_FAILURE_REASONS = [
  'FILE_CHOOSER_GUARD_UNAVAILABLE',
  'INVALID_TARGET',
  'NETWORK_POLICY_BLOCKED',
  'TARGET_COVERED',
  'TARGET_DETACHED',
  'TARGET_DISABLED',
  'TARGET_NOT_EDITABLE',
  'TARGET_NOT_FOCUSABLE',
  'TARGET_NOT_SELECTABLE',
  'TARGET_NOT_VISIBLE',
  'TARGET_READ_ONLY',
  'TARGET_UNSTABLE',
  'UNSUPPORTED_PROTOCOL',
] as const

export const BROWSER_DEFAULT_OBSERVATION_ELEMENT_LIMIT = 160

export const BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT = 400

export const BROWSER_MAX_OBSERVATION_TEXT_BYTES = 32 * 1_024

export const BROWSER_MAX_SCREENSHOT_BYTES = 16 * 1_024 * 1_024

export const BROWSER_ACTION_TEXT_MAX_LENGTH = 16 * 1_024

export const BROWSER_MAX_WAIT_TIMEOUT_MS = 15_000

export const BROWSER_ACTION_KINDS = [
  'navigate',
  'back',
  'forward',
  'reload',
  'stop',
  'click',
  'fill',
  'type',
  'press',
  'select',
  'scroll',
  'wait',
] as const

export const BROWSER_PRESS_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
] as const

export const BROWSER_WAIT_CONDITIONS = [
  'page-ready',
  'url-changed',
  'url-matches',
  'text-visible',
  'ref-visible',
  'ref-hidden',
  'dom-stable',
] as const

export const BROWSER_WAIT_TEXT_MAX_LENGTH = 512

export const BROWSER_WAIT_DEFAULT_QUIET_MS = 300

export const BROWSER_WAIT_MAX_QUIET_MS = 5_000

export const browserConversationIdSchema = z.string().trim().min(1).max(128)

export const browserIdSchema = z.uuid()

export const browserPathSchema = z.string().trim().min(1).max(32_768)

export const browserElementRefSchema = z.string().regex(/^e[1-9]\d*$/)

export const browserFrameIdSchema = z.string().trim().min(1).max(256)

export const browserUrlSchema = z.string().trim().min(1).max(4_096).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  }
  catch {
    return false
  }
})

export const browserRuntimeUrlSchema = z.union([
  z.literal('file:///[redacted]'),
  browserUrlSchema,
])

export const browserOriginSchema = z.string().min(1).max(4_096).refine((value) => {
  if (value === 'file://')
    return true
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.origin === value
  }
  catch {
    return false
  }
})

export const browserErrorCodeSchema = z.enum(BROWSER_ERROR_CODES)

export const browserFailureReasonSchema = z.enum(BROWSER_FAILURE_REASONS)

export const browserRecoveryActionSchema = z.enum(BROWSER_RECOVERY_ACTIONS)

export const browserActionKindSchema = z.enum(BROWSER_ACTION_KINDS)

export const browserErrorSchema = z.object({
  code: browserErrorCodeSchema,
  reason: browserFailureReasonSchema.nullable(),
  recovery: browserRecoveryActionSchema.nullable(),
}).strict()

export type BrowserErrorCode = z.infer<typeof browserErrorCodeSchema>

export type BrowserFailureReason = z.infer<typeof browserFailureReasonSchema>

export type BrowserRecoveryAction = z.infer<typeof browserRecoveryActionSchema>

export type BrowserError = z.infer<typeof browserErrorSchema>
