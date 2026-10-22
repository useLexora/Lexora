import type { FilePreview } from '../../../shared/files/filePreview'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import { inferFileMimeType, isImageMimeType, mediaKindForMimeType } from '../../../shared/files/fileMimeTypes'
import { FILE_IMAGE_PREVIEW_MAX_BYTES } from '../../../shared/files/filePreview'
import { decodeText } from '../changes/changeFileContent'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export async function readFilePreview(root: string, path: string, urls: { image: string, media?: string }): Promise<FilePreview> {
  const metadata = await stat(path)
  if (!metadata.isFile())
    throw new BuddyServiceError('VALIDATION_FAILED')
  const mimeType = inferFileMimeType(path)
  const mediaKind = mediaKindForMimeType(mimeType)
  if (mediaKind && urls.media)
    return { kind: mediaKind, sizeBytes: metadata.size, text: null, imageUrl: null, mediaUrl: urls.media }
  const image = isImageMimeType(mimeType)
  const maximum = image ? FILE_IMAGE_PREVIEW_MAX_BYTES : 1024 * 1024
  if (metadata.size > maximum)
    return { kind: 'oversized', sizeBytes: metadata.size, text: null, imageUrl: null }
  if (image) {
    const url = new URL(urls.image)
    url.searchParams.set('v', randomUUID())
    return { kind: 'image', sizeBytes: metadata.size, text: null, imageUrl: url.href }
  }
  const bytes = await readBoundedFile(root, path, maximum)
  const text = decodeText(bytes)
  return { kind: text === null ? 'binary' : 'text', sizeBytes: bytes.length, text, imageUrl: null }
}
