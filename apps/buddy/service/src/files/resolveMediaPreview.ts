import type { MediaPreviewLocation } from '../../../shared/files/mediaPreview'
import { lstat, realpath } from 'node:fs/promises'
import { containsCanonicalPath } from '../../../platform/filesystem/filePaths'
import { inferFileMimeType, isImageMimeType, mediaKindForMimeType } from '../../../shared/files/fileMimeTypes'
import { mediaFileIdentity } from '../../../shared/files/mediaPreview'
import { createSensitivePathMatcher } from '../permissions/sensitivePaths'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export async function resolveMediaPreview(root: string, path: string, options: { mimeType?: string, imageBytesLimit?: number } = {}): Promise<MediaPreviewLocation> {
  const mimeType = options.mimeType ?? inferFileMimeType(path)
  if (!isImageMimeType(mimeType) && !mediaKindForMimeType(mimeType))
    throw new BuddyServiceError('VALIDATION_FAILED')
  const sensitive = createSensitivePathMatcher()
  if (sensitive.matches(root) || sensitive.matches(path)
    || await realpath(root) !== root || await realpath(path) !== path
    || !containsCanonicalPath(root, path)) {
    throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
  }
  const metadata = await lstat(path, { bigint: true })
  if (!metadata.isFile() || metadata.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new BuddyServiceError('VALIDATION_FAILED')
  if (isImageMimeType(mimeType) && options.imageBytesLimit !== undefined && metadata.size > BigInt(options.imageBytesLimit))
    throw new BuddyServiceError('VALIDATION_FAILED')
  return { root, path, mimeType, sizeBytes: Number(metadata.size), identity: mediaFileIdentity(metadata) }
}
