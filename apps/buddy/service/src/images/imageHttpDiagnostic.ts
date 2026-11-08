import type { ImageGenerationErrorDiagnostic } from './ImageGenerationGateway'
import { diagnosticResponseType, diagnosticTransportCode } from '../../../shared/diagnostics/providerRequestDiagnostic'
import { readImageDiagnostic } from '../../../shared/images/imageGeneration'
import { ImageGenerationError } from './ImageGenerationGateway'
import { readBoundedResponse } from './imageResponseBody'

export function imageResponseDiagnostic(response: Response, body?: unknown): ImageGenerationErrorDiagnostic {
  let value = body
  try {
    if (typeof value === 'string')
      value = JSON.parse(value)
  }
  catch { value = undefined }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  const error = record?.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : record
  const unsupportedParameter = typeof error?.message === 'string'
    ? /^(model|prompt|n|size|quality|background|response_format|output_format|ratio) is not supported\b/.exec(error.message)?.[1]
    : undefined
  return {
    stage: 'receiving',
    httpStatus: response.status,
    responseType: diagnosticResponseType(response.headers.get('content-type')),
    ...readImageDiagnostic({
      responseId: record?.id,
      providerCode: error?.code,
      providerParameter: error?.param || error?.parameter || unsupportedParameter,
      requestId: response.headers.get('x-request-id') ?? response.headers.get('openai-request-id'),
    }),
  }
}

export async function imageHttpFailure(response: Response, signal: AbortSignal): Promise<ImageGenerationError> {
  let body: string | undefined
  if (diagnosticResponseType(response.headers.get('content-type')) !== 'html') {
    try {
      body = await readBoundedResponse(response, AbortSignal.any([signal, AbortSignal.timeout(1000)]))
    }
    catch { signal.throwIfAborted() }
  }
  else {
    void response.body?.cancel().catch(() => {})
  }
  return new ImageGenerationError(response.status === 401 ? 'PROVIDER_AUTHENTICATION_FAILED' : response.status === 403 ? 'PROVIDER_ACCESS_DENIED' : response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'IMAGE_GENERATION_FAILED', {
    diagnostic: imageResponseDiagnostic(response, body),
    outcome: response.status >= 500 ? 'unknown' : 'failed',
    retryable: [400, 401, 403, 404, 422, 429].includes(response.status),
  })
}

export function imageTransportFailure(cause: unknown, diagnostic: ImageGenerationErrorDiagnostic): ImageGenerationError {
  const transportCode = diagnosticTransportCode(cause)
  const notSubmitted = diagnostic.stage === 'submitting' && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERTIFICATE_VERIFY_FAILED'].includes(transportCode ?? '')
  return new ImageGenerationError(notSubmitted ? 'IMAGE_GENERATION_FAILED' : 'IMAGE_GENERATION_INCOMPLETE', {
    cause,
    outcome: notSubmitted ? 'failed' : 'unknown',
    diagnostic: { ...diagnostic, transportCode },
  })
}
