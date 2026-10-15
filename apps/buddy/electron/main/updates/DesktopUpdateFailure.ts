import type { DesktopUpdateFailureKind } from '../../shared/desktopUpdates'

export function readDesktopUpdateFailure(error: unknown): { kind: DesktopUpdateFailureKind, code: string } {
  const message = error instanceof Error ? error.message : ''
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (error instanceof Error && error.name === 'TimeoutError')
    return { kind: 'timeout', code: 'UPDATE_DOWNLOAD_TIMEOUT' }
  if (message === 'UPDATE_PACKAGE_INVALID')
    return { kind: 'verification', code: message }
  if (message === 'UPDATE_CACHE_INVALID' || (typeof code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EMFILE'].includes(code)))
    return { kind: 'storage', code: message === 'UPDATE_CACHE_INVALID' ? message : 'UPDATE_CACHE_WRITE_FAILED' }
  return { kind: 'download', code: message === 'UPDATE_DOWNLOAD_URL_INVALID' ? message : 'UPDATE_DOWNLOAD_FAILED' }
}
