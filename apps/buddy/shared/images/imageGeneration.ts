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
  'IMAGE_GENERATION_UNSUPPORTED',
  'PROVIDER_ACCESS_DENIED',
  'PROVIDER_AUTHENTICATION_FAILED',
  'PROVIDER_RATE_LIMITED',
] as const

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
  lastEvent: z.enum(['response.created', 'response.in_progress', 'response.output_item.added', 'response.output_item.done', 'response.image_generation_call.in_progress', 'response.image_generation_call.generating', 'response.image_generation_call.partial_image', 'response.image_generation_call.completed', 'response.completed', 'response.done', 'response.failed', 'response.incomplete', 'response.cancelled', 'error', '[DONE]', 'other']).optional(),
}).strict()
export const imageGenerationFailureSchema = z.object({
  code: z.enum([...IMAGE_GENERATION_ERROR_CODES, 'VALIDATION_FAILED']),
  outcome: imageGenerationOutcomeSchema,
  diagnostic: imageGenerationDiagnosticSchema.nullable(),
}).strict()

export const imageRequestRefSchema = z.object({ conversationId: z.uuid(), runId: z.uuid(), requestId: z.uuid() }).strict()
export type ImageGenerationErrorCode = typeof IMAGE_GENERATION_ERROR_CODES[number]
export type ImageGenerationOutcome = z.infer<typeof imageGenerationOutcomeSchema>
export type ImageGenerationErrorDiagnostic = z.infer<typeof imageGenerationDiagnosticSchema>
export type ImageGenerationFailure = z.infer<typeof imageGenerationFailureSchema>
export type ImageRequestRef = z.infer<typeof imageRequestRefSchema>

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
