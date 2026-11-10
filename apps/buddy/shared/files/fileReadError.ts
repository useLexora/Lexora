import { parseLocalChatPublicError, readLocalChatErrorCode } from '../runtime/localChatError'

export type FileReadErrorCode = 'FILE_NOT_FOUND' | 'FILE_ACCESS_DENIED' | 'FILE_TOO_LARGE' | 'FILE_UNSUPPORTED' | 'FILE_CHANGED' | 'FILE_READ_FAILED'

export class FileReadError extends Error {
  readonly code: FileReadErrorCode

  constructor(code: FileReadErrorCode, options?: ErrorOptions) {
    super('Lexora could not read the file', options)
    this.name = 'FileReadError'
    this.code = code
  }
}

export function fileReadErrorCode(error: unknown): FileReadErrorCode {
  const publicCode = readLocalChatErrorCode(error)
    ?? (error instanceof Error ? parseLocalChatPublicError(error.message)?.code : undefined)
  const codes: Record<string, FileReadErrorCode> = {
    FILE_NOT_FOUND: 'FILE_NOT_FOUND',
    ARTIFACT_NOT_FOUND: 'FILE_NOT_FOUND',
    ENOENT: 'FILE_NOT_FOUND',
    ENOTDIR: 'FILE_NOT_FOUND',
    PATH_NOT_FOUND: 'FILE_NOT_FOUND',
    FILE_ACCESS_DENIED: 'FILE_ACCESS_DENIED',
    EACCES: 'FILE_ACCESS_DENIED',
    EPERM: 'FILE_ACCESS_DENIED',
    DIRECTORY_NOT_AUTHORIZED: 'FILE_ACCESS_DENIED',
    FILE_PERMISSION_REVOKED: 'FILE_ACCESS_DENIED',
    FILE_TOO_LARGE: 'FILE_TOO_LARGE',
    ARTIFACT_SIZE_LIMIT: 'FILE_TOO_LARGE',
    BOUNDED_FILE_OUTPUT_LIMIT: 'FILE_TOO_LARGE',
    FILE_UNSUPPORTED: 'FILE_UNSUPPORTED',
    EISDIR: 'FILE_UNSUPPORTED',
    FILE_CHANGED: 'FILE_CHANGED',
    SOURCE_CHANGED: 'FILE_CHANGED',
    FILE_READ_FAILED: 'FILE_READ_FAILED',
  }
  if (publicCode && codes[publicCode])
    return codes[publicCode]
  const seen = new Set<object>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    if ('code' in error && typeof error.code === 'string' && codes[error.code])
      return codes[error.code]!
    error = 'cause' in error ? error.cause : undefined
  }
  return 'FILE_READ_FAILED'
}

export function fileReadErrorResponse(error: unknown): Response {
  const code = fileReadErrorCode(error)
  const status = { FILE_NOT_FOUND: 404, FILE_ACCESS_DENIED: 403, FILE_TOO_LARGE: 413, FILE_UNSUPPORTED: 415, FILE_CHANGED: 409, FILE_READ_FAILED: 500 }[code]
  return new Response(null, { status, headers: { 'x-lexora-error-code': code, 'cache-control': 'no-store' } })
}
