import { constants } from 'node:os'
import { getSystemErrorName } from 'node:util'
import { launchLocationExtensionId } from '../../shared/extensions/extensionLaunchLocation'

type StorageErrno = 'EDQUOT' | 'ENOSPC'

export function storageErrno(error: unknown): StorageErrno | undefined {
  if (!(error instanceof Error))
    return undefined
  const { code, errno } = error as NodeJS.ErrnoException
  if (code === 'EDQUOT' || code === 'ENOSPC')
    return code
  if (typeof errno !== 'number' || !Number.isSafeInteger(errno) || errno >= 0)
    return undefined
  const name = getSystemErrorName(errno)
  if (name === 'EDQUOT' || errno === -constants.errno.EDQUOT)
    return 'EDQUOT'
  if (name === 'ENOSPC' || errno === -constants.errno.ENOSPC)
    return 'ENOSPC'
  return undefined
}

export class ExtensionLaunchStorageError extends Error {
  readonly errno: StorageErrno
  readonly location?: string
  constructor(errno: StorageErrno, location: string, cause: unknown) {
    super('Extension launch storage write failed', { cause })
    this.errno = errno
    this.location = launchLocationExtensionId(location) ? location : undefined
  }
}

export async function withExtensionLaunchStorage<T>(location: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  }
  catch (cause) {
    const errno = storageErrno(cause)
    if (errno)
      throw new ExtensionLaunchStorageError(errno, location, cause)
    throw cause
  }
}
