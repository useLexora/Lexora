import { z } from 'zod'
import { providerRequestDiagnosticSchema } from '../diagnostics/providerRequestDiagnostic'

export const IMAGE_GENERATION_ERROR_CODES = [
  'IMAGE_GENERATION_FAILED',
  'IMAGE_GENERATION_BUSY',
  'IMAGE_GENERATION_RESOURCE_EXHAUSTED',
  'IMAGE_GENERATION_INCOMPLETE',
  'IMAGE_GENERATION_BLOCKED',
  'IMAGE_GENERATION_INVALID_RESPONSE',
  'IMAGE_GENERATION_RESPONSE_TOO_LARGE',
  'IMAGE_GENERATION_REFERENCE_UNAVAILABLE',
  'IMAGE_GENERATION_OUTPUT_UNAVAILABLE',
  'IMAGE_GENERATION_UNSUPPORTED',
  'PROVIDER_ACCESS_DENIED',
  'PROVIDER_AUTHENTICATION_FAILED',
  'PROVIDER_RATE_LIMITED',
] as const

export const imageGenerationRetainedOutputSchema = z.object({
  path: z.string().min(1),
  mimeType: z.literal('image/png'),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type ImageGenerationRetainedOutput = z.infer<typeof imageGenerationRetainedOutputSchema>

export const imageGenerationOutcomeSchema = z.enum(['failed', 'unknown', 'partial'])
const diagnosticTokenSchema = z.string().min(1).max(256).regex(/^[\w.\-[\]:/]+$/)
export const imageGenerationDiagnosticSchema = z.object({
  stage: z.enum(['preparing', 'submitting', 'receiving', 'publishing', 'blocked']).optional(),
  localRequestId: z.uuid().optional(),
  requestId: diagnosticTokenSchema.optional(),
  responseId: diagnosticTokenSchema.optional(),
  providerCode: diagnosticTokenSchema.optional(),
  providerParameter: diagnosticTokenSchema.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  responseType: providerRequestDiagnosticSchema.shape.responseType,
  transportCode: providerRequestDiagnosticSchema.shape.transportCode,
  fileErrorCode: z.enum([
    'EACCES',
    'EPERM',
    'EROFS',
    'ENOSPC',
    'EDQUOT',
    'ENOENT',
    'ENOTDIR',
    'EISDIR',
    'EEXIST',
    'ELOOP',
    'ENAMETOOLONG',
    'EIO',
    'EMFILE',
    'ENFILE',
    'INVALID_PATH',
    'PATH_NOT_FOUND',
    'PATH_OUTSIDE_GRANTED_DIRECTORY',
    'DIRECTORY_NOT_AUTHORIZED',
    'DIRECTORY_GRANT_CHANGED',
    'TOOL_AUTHORIZATION_UNAVAILABLE',
    'FILE_CONFLICT',
    'FILE_INVALID_REQUEST',
    'FILE_IO_FAILED',
    'FILE_JOURNAL_FAILED',
    'FILE_LEASE_INVALID',
    'FILE_NOT_FOUND',
    'FILE_OPERATION_CANCELLED',
    'FILE_OPERATION_ID_CONFLICT',
    'FILE_PERMISSION_REVOKED',
    'FILE_PROTOCOL_FAILED',
    'FILE_RECOVERY_REQUIRED',
    'FILE_UNSUPPORTED',
    'FILE_ENGINE_UNAVAILABLE',
    'FILE_ENGINE_INTERRUPTED',
    'FILE_ENGINE_BUSY',
    'IMAGE_MATERIAL_IDENTITY_CHANGED',
    'IMAGE_MATERIAL_UNAVAILABLE',
    'ARTIFACT_PUBLICATION_FAILED',
    'ARTIFACT_SIZE_LIMIT',
    'VALIDATION_FAILED',
  ]).optional(),
  lastEvent: z.enum(['response.created', 'response.in_progress', 'response.output_item.added', 'response.output_item.done', 'response.image_generation_call.in_progress', 'response.image_generation_call.generating', 'response.image_generation_call.partial_image', 'response.image_generation_call.completed', 'response.completed', 'response.done', 'response.failed', 'response.incomplete', 'response.cancelled', 'error', '[DONE]', 'other']).optional(),
}).strict()
export const imageGenerationFailureSchema = z.object({
  code: z.enum([...IMAGE_GENERATION_ERROR_CODES, 'VALIDATION_FAILED']),
  outcome: imageGenerationOutcomeSchema,
  diagnostic: imageGenerationDiagnosticSchema.nullable(),
  retainedOutputs: z.array(imageGenerationRetainedOutputSchema).optional(),
}).strict()

export const imageRequestRefSchema = z.object({ conversationId: z.uuid(), runId: z.uuid(), requestId: z.uuid() }).strict()
export type ImageGenerationErrorCode = typeof IMAGE_GENERATION_ERROR_CODES[number]
export type ImageGenerationOutcome = z.infer<typeof imageGenerationOutcomeSchema>
export type ImageGenerationErrorDiagnostic = z.infer<typeof imageGenerationDiagnosticSchema>
export type ImageGenerationFailure = z.infer<typeof imageGenerationFailureSchema>
export type ImageRequestRef = z.infer<typeof imageRequestRefSchema>

export function readImageFileErrorCode(error: unknown): ImageGenerationErrorDiagnostic['fileErrorCode'] {
  const seen = new Set<object>()
  let code: ImageGenerationErrorDiagnostic['fileErrorCode']
  for (let current = error; current && typeof current === 'object' && seen.size < 8 && !seen.has(current); current = 'cause' in current ? current.cause : undefined) {
    seen.add(current)
    const parsed = imageGenerationDiagnosticSchema.shape.fileErrorCode.safeParse('code' in current ? current.code : 'message' in current ? current.message : undefined)
    if (parsed.success && parsed.data)
      code = parsed.data
  }
  return code
}

export function readImageDiagnostic(value: unknown): ImageGenerationErrorDiagnostic | null {
  if (!value || typeof value !== 'object')
    return null
  const record = value as Record<string, unknown>
  const diagnostic: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(imageGenerationDiagnosticSchema.shape)) {
    const result = schema.safeParse(record[key])
    if (result.success && result.data !== undefined)
      diagnostic[key] = result.data
  }
  return Object.keys(diagnostic).length ? diagnostic as ImageGenerationErrorDiagnostic : null
}
