import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ProviderRequestDiagnostic } from '../../../shared/diagnostics/providerRequestDiagnostic'
import { providerRequestDiagnosticSchema } from '../../../shared/diagnostics/providerRequestDiagnostic'
import { redactSensitiveText } from '../../../shared/permissions/approvalReviewPayload'

export const MODEL_REQUEST_FAILURE_DIAGNOSTIC = 'model.request.failure'

const MAX_FAILURE_MESSAGE_LENGTH = 4 * 1024
type FailureEvidence = Pick<ProviderRequestDiagnostic, 'status' | 'transportCode'>

export type ModelRequestFailureCode
  = 'MODEL_NOT_SUPPORTED'
    | 'MODEL_INPUT_UNSUPPORTED'
    | 'MODEL_INPUT_TOO_LARGE'
    | 'RESOURCE_MATERIALIZATION_FAILED'
    | 'MODEL_RESOURCES_CHANGED'
    | 'MODEL_RESOURCES_UNAVAILABLE'
    | 'MODEL_LOAD_FAILED'
    | 'MODEL_RESOURCE_EXHAUSTED'
    | 'MODEL_PROCESS_EXITED'
    | 'MODEL_CONFIGURATION_CHANGED'
    | 'MODEL_REQUEST_FAILED'
    | 'MODEL_STREAM_INCOMPLETE'
    | 'MODEL_REQUEST_TIMED_OUT'
    | 'MODEL_SERVICE_UNAVAILABLE'
    | 'MODEL_SERVICE_UNREACHABLE'
    | 'PROVIDER_ACCESS_DENIED'
    | 'PROVIDER_AUTHENTICATION_FAILED'
    | 'PROVIDER_RATE_LIMITED'

export function normalizeModelRequestFailure(input: string | Pick<AssistantMessage, 'errorMessage' | 'diagnostics'> | undefined): {
  code: ModelRequestFailureCode
  message?: string
} {
  const value = typeof input === 'object' ? input.errorMessage : input
  const details = typeof input === 'object'
    ? input.diagnostics?.findLast(item => item.type === MODEL_REQUEST_FAILURE_DIAGNOSTIC)?.details
    : undefined
  const transportCode = providerRequestDiagnosticSchema.shape.transportCode.safeParse(details?.transportCode)
  const normalized = value
    ? redactSensitiveText(value
        .replace(
          /("(?:api[-_]?key|(?:access|refresh|id)[-_]?token|client[-_]?secret|secret|token|password|credential|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
          '$1"[redacted]"',
        )
        .replace(
          /(\bIncorrect API key provided\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
          '$1[redacted]',
        )).trim()
    : ''
  const message = normalized ? normalized.slice(0, MAX_FAILURE_MESSAGE_LENGTH) : undefined
  return {
    code: classifyModelRequestFailure(message, {
      status: typeof details?.status === 'number' ? details.status : undefined,
      transportCode: transportCode.success ? transportCode.data : undefined,
    }),
    ...(message ? { message } : {}),
  }
}

function classifyModelRequestFailure(message: string | undefined, evidence: FailureEvidence): ModelRequestFailureCode {
  const transportCode = evidence.transportCode
  if (transportCode && transportCode !== 'UNKNOWN' && transportCode !== 'ABORTED')
    return /TIME(?:DOUT|OUT)/.test(transportCode) ? 'MODEL_REQUEST_TIMED_OUT' : 'MODEL_SERVICE_UNREACHABLE'
  const status = evidence.status ?? Number(/^\s*(?:HTTP(?:\/[\d.]+)?\s+)?([45]\d{2})\b/i.exec(message ?? '')?.[1])
  if (status === 401)
    return 'PROVIDER_AUTHENTICATION_FAILED'
  if (status === 403)
    return 'PROVIDER_ACCESS_DENIED'
  if (status === 429)
    return 'PROVIDER_RATE_LIMITED'
  if (status === 408 || status === 504)
    return 'MODEL_REQUEST_TIMED_OUT'
  if (status >= 500 && status <= 599)
    return 'MODEL_SERVICE_UNAVAILABLE'
  if (message === 'MODEL_INPUT_UNSUPPORTED' || message === 'MODEL_INPUT_TOO_LARGE' || message === 'RESOURCE_MATERIALIZATION_FAILED')
    return message
  if (!message)
    return 'MODEL_REQUEST_FAILED'
  if (message === 'EXTENSION_INFERENCE_CONTEXT_TOO_LARGE')
    return 'MODEL_INPUT_TOO_LARGE'
  if (message === 'EXTENSION_INFERENCE_INPUT_UNSUPPORTED')
    return 'MODEL_INPUT_UNSUPPORTED'
  if (message === 'EXTENSION_INFERENCE_OUTPUT_INCOMPLETE')
    return 'MODEL_STREAM_INCOMPLETE'
  if (message === 'EXTENSION_INFERENCE_RESOURCE_CHANGED' || message === 'EXTENSION_INFERENCE_CHECKSUM_MISMATCH')
    return 'MODEL_RESOURCES_CHANGED'
  if (message === 'EXTENSION_INFERENCE_RESOURCE_UNAVAILABLE' || message === 'EXTENSION_INFERENCE_RESOURCE_NOT_EXECUTABLE')
    return 'MODEL_RESOURCES_UNAVAILABLE'
  if (message === 'EXTENSION_INFERENCE_RESOURCE_EXHAUSTED')
    return 'MODEL_RESOURCE_EXHAUSTED'
  if (message === 'EXTENSION_INFERENCE_LOAD_FAILED')
    return 'MODEL_LOAD_FAILED'
  if (message === 'EXTENSION_INFERENCE_PROCESS_EXITED')
    return 'MODEL_PROCESS_EXITED'
  if (message === 'EXTENSION_INFERENCE_CONFIGURATION_CHANGED')
    return 'MODEL_CONFIGURATION_CHANGED'
  if (/\b(?:TLS|SSL|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)\b|certificate (?:has expired|verify failed|verification failed|validation failed)|self[- ]signed certificate/i.test(message))
    return /timed? out|timeout/i.test(message) ? 'MODEL_REQUEST_TIMED_OUT' : 'MODEL_SERVICE_UNREACHABLE'
  if (/stream ended without (?:a )?finish(?:_| )reason|stream (?:was )?(?:aborted|interrupted)|stream ended before (?:message_stop|a terminal response event)|stream disconnected before completion/i.test(message))
    return 'MODEL_STREAM_INCOMPLETE'
  if (
    /(?:unknown|unsupported|invalid)\s+model|model.{0,80}(?:not found|does not exist|not supported|unsupported)|(?:不支持|找不到|不存在|未知).{0,20}模型|模型.{0,20}(?:不支持|找不到|不存在|未知)/i.test(message)
  ) {
    return 'MODEL_NOT_SUPPORTED'
  }
  if (/\b401\b|unauthori[sz]ed|authentication failed|invalid api[-_ ]?key|认证失败|密钥无效/i.test(message))
    return 'PROVIDER_AUTHENTICATION_FAILED'
  if (/\b403\b|forbidden|access denied|permission denied|无权访问|权限不足/i.test(message))
    return 'PROVIDER_ACCESS_DENIED'
  if (/\b429\b|too many requests|rate limit|速率限制|请求过多/i.test(message))
    return 'PROVIDER_RATE_LIMITED'
  if (/\b504\b|ETIMEDOUT|timed? out|timeout|请求超时|响应超时/i.test(message))
    return 'MODEL_REQUEST_TIMED_OUT'
  if (/\b5\d{2}\b|service unavailable|服务不可用/i.test(message))
    return 'MODEL_SERVICE_UNAVAILABLE'
  if (
    /\b404\b|ECONN(?:REFUSED|RESET)|ENOTFOUND|EAI_AGAIN|fetch failed|network error|socket hang up|connection (?:abort|closed|lost)|unable to connect|failed to connect|无法连接|连接失败|网络错误/i.test(message)
  ) {
    return 'MODEL_SERVICE_UNREACHABLE'
  }
  return 'MODEL_REQUEST_FAILED'
}
