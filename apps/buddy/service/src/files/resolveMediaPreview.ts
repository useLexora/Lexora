import type { MediaPreviewLocation } from '../../../shared/files/mediaPreview'
import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { containsCanonicalPath } from '../../../platform/filesystem/filePaths'
import { inferFileMimeType, isImageMimeType, mediaKindForMimeType } from '../../../shared/files/fileMimeTypes'
import { FileReadError, fileReadErrorCode } from '../../../shared/files/fileReadError'
import { mediaFileIdentity } from '../../../shared/files/mediaPreview'
import { createSensitivePathMatcher } from '../permissions/sensitivePaths'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export async function resolveMediaPreview(root: string, path: string, options: { mimeType?: string, imageBytesLimit?: number } = {}): Promise<MediaPreviewLocation> {
  const mimeType = options.mimeType ?? inferFileMimeType(path)
  if (!isImageMimeType(mimeType) && !mediaKindForMimeType(mimeType))
    throw new FileReadError('FILE_UNSUPPORTED')
  const sensitive = createSensitivePathMatcher()
  if (sensitive.matches(root) || sensitive.matches(path)
    || await realpath(root) !== root || await realpath(path) !== path
    || !containsCanonicalPath(root, path)) {
    throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
  }
  return resolveMediaFile(root, path, options)
}

export async function resolveMediaFile(root: string, path: string, options: { mimeType?: string, imageBytesLimit?: number } = {}): Promise<MediaPreviewLocation> {
  try {
    const mimeType = options.mimeType ?? inferFileMimeType(path)
    if (!isImageMimeType(mimeType) && !mediaKindForMimeType(mimeType))
      throw new FileReadError('FILE_UNSUPPORTED')
    const metadata = await lstat(path, { bigint: true })
    if (!metadata.isFile())
      throw new FileReadError('FILE_UNSUPPORTED')
    if (metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
      || (isImageMimeType(mimeType) && options.imageBytesLimit !== undefined && metadata.size > BigInt(options.imageBytesLimit))) {
      throw new FileReadError('FILE_TOO_LARGE')
    }
    await access(path, constants.R_OK)
    return { root, path, mimeType, sizeBytes: Number(metadata.size), identity: mediaFileIdentity(metadata) }
  }
  catch (error) {
    throw new FileReadError(fileReadErrorCode(error), { cause: error })
  }
}
