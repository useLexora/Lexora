import { z } from 'zod'

export const PRODUCT_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_PARAMS',
  'METHOD_NOT_AVAILABLE',
  'NOT_INITIALIZED',
  'ALREADY_INITIALIZED',
  'PROTOCOL_INCOMPATIBLE',
  'NOT_AUTHORIZED',
  'SERVICE_NOT_READY',
  'SERVICE_STOPPING',
  'DATA_GENERATION_CHANGED',
  'SERVICE_INSTANCE_CHANGED',
  'COMMAND_ACTOR_UNAVAILABLE',
  'COMMAND_ID_REUSED',
  'COMMAND_FINGERPRINT_UNSUPPORTED',
  'COMMAND_RESULT_UNKNOWN',
  'FRAME_TOO_LARGE',
  'PAGE_TOO_LARGE',
  'CURSOR_INVALID',
  'CURSOR_EXPIRED',
  'CONTENT_UNSUPPORTED',
  'ACTION_NOT_ALLOWED',
  'DRAFT_CONFLICT',
  'SOURCE_CHANGED',
  'QUEUE_CHANGED',
  'REVIEW_CHANGED',
  'APPROVAL_ALREADY_RESOLVED',
  'QUESTION_CLOSED',
  'QUESTION_STALE',
  'QUESTION_NOT_FOUND',
  'QUESTION_ANSWER_INVALID',
  'RESOURCE_UNAVAILABLE',
  'OBJECT_DELETED',
  'DESKTOP_UNAVAILABLE',
  'INPUT_DELIVERY_TARGET_UNAVAILABLE',
  'INPUT_DELIVERY_INCOMPATIBLE',
  'SYNC_INVALID',
  'RESYNC_REQUIRED',
  'INTERNAL_ERROR',
] as const
export const productErrorCodeSchema = z.enum(PRODUCT_ERROR_CODES)
export type ProductErrorCode = z.infer<typeof productErrorCodeSchema>
export const productErrorSchema = z.object({
  code: productErrorCodeSchema,
  message: z.string().max(128),
  acceptance: z.enum(['not_accepted', 'unknown']),
  recovery: z.enum(['none', 'correct_request', 'initialize', 'refresh', 'query_command', 'reauthenticate']),
}).strict()
export type ProductError = z.infer<typeof productErrorSchema>

export class ProductProtocolError extends Error {
  readonly code: ProductErrorCode
  readonly acceptance: ProductError['acceptance']

  constructor(code: ProductErrorCode, acceptance: ProductError['acceptance'] = 'not_accepted') {
    super(code)
    this.code = code
    this.acceptance = acceptance
  }
}

export function projectProductError(error: unknown, commandDispatched = false, outcomeMayBeCommitted = false): ProductError {
  const code = productErrorCodeSchema.safeParse(error instanceof ProductProtocolError ? error.code : error && typeof error === 'object' && 'code' in error ? error.code : null)
  const safeCode = code.success ? code.data : 'INTERNAL_ERROR'
  const unknown = outcomeMayBeCommitted || safeCode === 'COMMAND_RESULT_UNKNOWN' || (error instanceof ProductProtocolError ? error.acceptance === 'unknown' : commandDispatched)
  return {
    code: safeCode,
    message: safeCode,
    acceptance: unknown ? 'unknown' : 'not_accepted',
    recovery: unknown ? 'query_command' : safeCode === 'NOT_INITIALIZED' ? 'initialize' : safeCode === 'NOT_AUTHORIZED' || safeCode === 'DATA_GENERATION_CHANGED' ? 'reauthenticate' : safeCode === 'INVALID_PARAMS' || safeCode === 'INVALID_REQUEST' ? 'correct_request' : 'refresh',
  }
}
