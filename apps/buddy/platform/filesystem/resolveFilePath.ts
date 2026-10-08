import { lstat, realpath, stat } from 'node:fs/promises'
import { filePaths } from './filePaths'

export interface ResolvedFilePath {
  canonicalPath: string
  requestedPath: string
  isDirectory: boolean
  isFile: boolean
}

export class FilePathResolutionError extends Error {
  readonly code: 'INVALID_PATH' | 'PATH_NOT_FOUND'

  constructor(code: FilePathResolutionError['code'], options?: ErrorOptions) {
    super('Lexora Buddy cannot resolve the requested file path', options)
    this.name = 'FilePathResolutionError'
    this.code = code
  }
}

export async function resolveFilePath(
  input: string,
  mode: 'existing' | 'create',
  cwd?: string,
): Promise<ResolvedFilePath> {
  try {
    const requestedPath = filePaths.resolveInput(input, cwd)
    const missingSegments: string[] = []
    let cursor = requestedPath
    while (true) {
      try {
        const canonicalParent = filePaths.resolveInput(await realpath(cursor))
        const metadata = await stat(canonicalParent)
        if (!metadata.isFile() && !metadata.isDirectory())
          throw new FilePathResolutionError('INVALID_PATH')
        if (missingSegments.length > 0 && !metadata.isDirectory())
          throw new FilePathResolutionError('INVALID_PATH')
        return {
          canonicalPath: filePaths.path.join(canonicalParent, ...missingSegments),
          requestedPath,
          isDirectory: missingSegments.length === 0 && metadata.isDirectory(),
          isFile: missingSegments.length === 0 && metadata.isFile(),
        }
      }
      catch (error) {
        if (mode !== 'create' || !isMissingPathError(error))
          throw error
        await rejectDanglingLink(cursor)
        const parent = filePaths.path.dirname(cursor)
        if (parent === cursor)
          throw new FilePathResolutionError('PATH_NOT_FOUND', { cause: error })
        missingSegments.unshift(filePaths.path.basename(cursor))
        cursor = parent
      }
    }
  }
  catch (error) {
    if (error instanceof FilePathResolutionError)
      throw error
    throw new FilePathResolutionError(isMissingPathError(error) ? 'PATH_NOT_FOUND' : 'INVALID_PATH', { cause: error })
  }
}

async function rejectDanglingLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new FilePathResolutionError('INVALID_PATH')
  }
  catch (error) {
    if (!isMissingPathError(error))
      throw error
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
