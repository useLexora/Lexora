import { parseLocalChatPublicError, readLocalChatErrorCode } from '@buddy-shared/runtime/localChatError'

const fileErrorKeys = {
  FILE_NOT_FOUND: 'desktop.context.previewFileMissing',
  FILE_ACCESS_DENIED: 'desktop.context.previewAccessDenied',
  FILE_TOO_LARGE: 'desktop.context.previewTooLarge',
  FILE_UNSUPPORTED: 'desktop.context.previewUnsupported',
  FILE_CHANGED: 'desktop.context.previewFileChanged',
  FILE_READ_FAILED: 'desktop.context.previewLoadFailed',
} as const

export type FilePreviewErrorKey = typeof fileErrorKeys[keyof typeof fileErrorKeys]
  | 'desktop.context.previewDecodeFailed'
  | 'desktop.context.mediaPlaybackFailed'

function fileErrorKey(code: string | null | undefined): FilePreviewErrorKey | null {
  return code && Object.hasOwn(fileErrorKeys, code)
    ? fileErrorKeys[code as keyof typeof fileErrorKeys]
    : null
}

export function resolveFileErrorKey(error: unknown): FilePreviewErrorKey | null {
  return fileErrorKey(readLocalChatErrorCode(error)
    ?? (error instanceof Error ? parseLocalChatPublicError(error.message)?.code : null))
}

export async function diagnoseFilePreviewError(src: string, signal: AbortSignal, fallback: FilePreviewErrorKey): Promise<FilePreviewErrorKey> {
  let url: URL
  try {
    url = new URL(src)
  }
  catch {
    return fallback
  }
  if (url.protocol !== 'lexora-artifact:' || !['preview', 'media'].includes(url.host) || url.username || url.password)
    return fallback

  try {
    const response = await fetch(src, { method: 'HEAD', signal, redirect: 'error', cache: 'no-store' })
    if (response.ok)
      return 'desktop.context.previewDecodeFailed'
    const key = fileErrorKey(response.headers.get('x-lexora-error-code'))
    if (key)
      return key
    const statusCodes: Record<number, keyof typeof fileErrorKeys> = {
      404: 'FILE_NOT_FOUND',
      403: 'FILE_ACCESS_DENIED',
      413: 'FILE_TOO_LARGE',
      415: 'FILE_UNSUPPORTED',
      409: 'FILE_CHANGED',
      500: 'FILE_READ_FAILED',
    }
    return fileErrorKey(statusCodes[response.status]) ?? fallback
  }
  catch {
    return fallback
  }
}
