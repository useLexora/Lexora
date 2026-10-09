export type LocalChatErrorCode
  = | 'APPROVAL_REQUIRED'
    | 'ATTACHMENT_LIMIT_EXCEEDED'
    | 'ATTACHMENT_UNSUPPORTED'
    | 'ATTACHMENT_TOO_LARGE'
    | 'ATTACHMENT_INVALID'
    | 'ATTACHMENT_IMPORT_FAILED'
    | 'AUTOMATION_CONFLICT'
    | 'AUTOMATION_INVALID_SCHEDULE'
    | 'AUTOMATION_NOT_FOUND'
    | 'AUTHENTICATION_REQUIRED'
    | 'CONNECTOR_UNAVAILABLE'
    | 'MCP_NAMESPACE_CONFLICT'
    | 'MCP_NAMESPACE_IMMUTABLE'
    | 'CREDENTIAL_STORE_FAILURE'
    | 'CREDENTIAL_STORE_UNAVAILABLE'
    | 'DIRECTORY_NOT_AUTHORIZED'
    | 'DRAFT_CONFLICT'
    | 'LOCAL_CHAT_OPERATION_FAILED'
    | 'MODEL_SYNC_FAILED'
    | 'MODEL_SYNC_UNSUPPORTED'
    | 'MODEL_INPUT_UNSUPPORTED'
    | 'MODEL_INPUT_TOO_LARGE'
    | 'PATH_OUTSIDE_GRANTED_DIRECTORY'
    | 'SKILL_NOT_FOUND'
    | 'SKILL_CHANGED'
    | 'SKILL_INVALID'
    | 'SKILL_TOO_LARGE'
    | 'SKILL_BUSY'
    | 'SKILL_READ_ONLY'
    | 'SKILL_INSTALL_FAILED'
    | 'SKILL_SOURCE_UNAVAILABLE'
    | 'SKILL_PREVIEW_EXPIRED'
    | 'SKILL_NAME_COLLISION'
    | 'SPACE_HAS_ACTIVE_RUNS'
    | 'SPACE_UNAVAILABLE'
    | 'PROVIDER_HAS_ACTIVE_RUNS'
    | 'PROVIDER_ID_CONFLICT'
    | 'PROVIDER_LOGIN_CANCELLED'
    | 'PROVIDER_UNAVAILABLE'
    | 'RUNTIME_PROTOCOL_ERROR'
    | 'RUNTIME_UNAVAILABLE'
    | 'VALIDATION_FAILED'

export interface LocalChatPublicError {
  code: LocalChatErrorCode
  retryable: boolean
}

const LOCAL_CHAT_ERROR_MARKER = 'LEXORA_LOCAL_CHAT_ERROR'

const LOCAL_CHAT_ERROR_PATTERN = /LEXORA_LOCAL_CHAT_ERROR:([A-Z0-9_]+):(0|1)/

const LOCAL_CHAT_ERROR_CODES = new Set<LocalChatErrorCode>([
  'APPROVAL_REQUIRED',
  'ATTACHMENT_LIMIT_EXCEEDED',
  'ATTACHMENT_UNSUPPORTED',
  'ATTACHMENT_TOO_LARGE',
  'ATTACHMENT_INVALID',
  'ATTACHMENT_IMPORT_FAILED',
  'AUTOMATION_CONFLICT',
  'AUTOMATION_INVALID_SCHEDULE',
  'AUTOMATION_NOT_FOUND',
  'AUTHENTICATION_REQUIRED',
  'CONNECTOR_UNAVAILABLE',
  'MCP_NAMESPACE_CONFLICT',
  'MCP_NAMESPACE_IMMUTABLE',
  'CREDENTIAL_STORE_FAILURE',
  'CREDENTIAL_STORE_UNAVAILABLE',
  'DIRECTORY_NOT_AUTHORIZED',
  'DRAFT_CONFLICT',
  'LOCAL_CHAT_OPERATION_FAILED',
  'MODEL_SYNC_FAILED',
  'MODEL_SYNC_UNSUPPORTED',
  'MODEL_INPUT_UNSUPPORTED',
  'MODEL_INPUT_TOO_LARGE',
  'PATH_OUTSIDE_GRANTED_DIRECTORY',
  'SKILL_NOT_FOUND',
  'SKILL_CHANGED',
  'SKILL_INVALID',
  'SKILL_TOO_LARGE',
  'SKILL_BUSY',
  'SKILL_READ_ONLY',
  'SKILL_INSTALL_FAILED',
  'SKILL_SOURCE_UNAVAILABLE',
  'SKILL_PREVIEW_EXPIRED',
  'SKILL_NAME_COLLISION',
  'SPACE_HAS_ACTIVE_RUNS',
  'SPACE_UNAVAILABLE',
  'PROVIDER_HAS_ACTIVE_RUNS',
  'PROVIDER_ID_CONFLICT',
  'PROVIDER_LOGIN_CANCELLED',
  'PROVIDER_UNAVAILABLE',
  'RUNTIME_PROTOCOL_ERROR',
  'RUNTIME_UNAVAILABLE',
  'VALIDATION_FAILED',
])

export function formatLocalChatPublicError(error: LocalChatPublicError): string {
  return `${LOCAL_CHAT_ERROR_MARKER}:${error.code}:${error.retryable ? '1' : '0'}`
}

export function parseLocalChatPublicError(message: string): LocalChatPublicError | null {
  const match = LOCAL_CHAT_ERROR_PATTERN.exec(message)
  if (!match || !isLocalChatErrorCode(match[1]))
    return null
  return { code: match[1], retryable: match[2] === '1' }
}

export function isLocalChatErrorCode(value: string | undefined): value is LocalChatErrorCode {
  return Boolean(value && LOCAL_CHAT_ERROR_CODES.has(value as LocalChatErrorCode))
}

export function readLocalChatErrorCode(error: unknown): LocalChatErrorCode | null {
  const seen = new Set<object>()
  while (isRecord(error) && !seen.has(error)) {
    seen.add(error)
    if (typeof error.code === 'string' && isLocalChatErrorCode(error.code))
      return error.code
    const data = isRecord(error.data) ? error.data : null
    if (typeof data?.code === 'string' && isLocalChatErrorCode(data.code))
      return data.code
    error = error.cause
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
