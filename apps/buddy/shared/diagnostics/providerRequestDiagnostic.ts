import { z } from 'zod'

export const providerRequestDiagnosticSchema = z.object({
  operation: z.enum(['completion', 'models']),
  api: z.enum(['openai-completions', 'openai-responses', 'other']),
  responseObserved: z.boolean(),
  status: z.number().int().min(100).max(599).optional(),
  responseType: z.enum(['sse', 'json', 'html', 'text', 'other', 'missing']).optional(),
  responseMs: z.number().finite().nonnegative().optional(),
  responseCount: z.number().int().nonnegative().optional(),
  contentEvents: z.number().int().nonnegative().optional(),
  textCharacters: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  doneMarker: z.enum(['observed', 'not_observed', 'unknown']).optional(),
  completion: z.enum(['sdk', 'inferred', 'incomplete', 'unknown']).optional(),
  failureStage: z.enum(['request', 'http', 'decode', 'schema', 'stream', 'unknown']).optional(),
  transportCode: z.enum(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ABORTED', 'UNKNOWN']).optional(),
}).strict()

export type ProviderRequestDiagnostic = z.infer<typeof providerRequestDiagnosticSchema>

export function diagnosticResponseType(contentType: string | null): ProviderRequestDiagnostic['responseType'] {
  if (!contentType)
    return 'missing'
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  if (type === 'text/event-stream')
    return 'sse'
  if (type === 'application/json' || type.endsWith('+json'))
    return 'json'
  if (type === 'text/html')
    return 'html'
  if (type.startsWith('text/'))
    return 'text'
  return 'other'
}

export function diagnosticTransportCode(error: unknown): ProviderRequestDiagnostic['transportCode'] {
  const seen = new Set<object>()
  for (let current = error; current && typeof current === 'object' && seen.size < 8 && !seen.has(current); current = 'cause' in current ? current.cause : undefined) {
    seen.add(current)
    if ('name' in current && current.name === 'AbortError')
      return 'ABORTED'
    const parsed = providerRequestDiagnosticSchema.shape.transportCode.safeParse('code' in current ? current.code : undefined)
    if (parsed.success && parsed.data)
      return parsed.data
  }
  return 'UNKNOWN'
}
