import { ExtensionLaunchStorageError, storageErrno } from './extensionLaunchStorage'

export function inferenceStorageFailure(error: unknown) {
  if (error instanceof ExtensionLaunchStorageError)
    return error.errno === 'EDQUOT' ? 'EXTENSION_INFERENCE_LAUNCH_QUOTA_EXCEEDED' : 'EXTENSION_INFERENCE_LAUNCH_NO_SPACE'
  const errno = storageErrno(error)
  if (errno === 'EDQUOT')
    return 'EXTENSION_INFERENCE_STORAGE_QUOTA_EXCEEDED' as const
  if (errno === 'ENOSPC')
    return 'EXTENSION_INFERENCE_STORAGE_NO_SPACE' as const
  return undefined
}
