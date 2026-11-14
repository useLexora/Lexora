import type { AttachmentRecord } from '../storage/attachmentRepository'
import type { AttachmentDocumentReference } from './AttachmentDocumentReference'
import type { AttachmentImageReference } from './AttachmentImageReference'
import { extname } from 'node:path'
import { BUDDY_MEDIA_EXTENSIONS, BUDDY_MEDIA_FILE_BYTES_LIMIT, isDocumentMimeType } from '../../../shared/conversation/attachmentFormats'
import { BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT, BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT, BUDDY_TEXT_ATTACHMENT_EXTENSIONS, getAttachmentKind, isTextAttachmentMimeType } from '../../../shared/conversation/attachmentPolicy'
import { AttachmentError } from './AttachmentError'

const MIME_TYPES: Readonly<Record<string, string>> = {
  ...BUDDY_MEDIA_EXTENSIONS,
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.toml': 'application/toml',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}
const SUPPORTED_IMAGE_MIME_TYPES = new Set(
  Object.values(MIME_TYPES).filter(mimeType => mimeType.startsWith('image/')),
)
const textExtensions = new Set<string>(BUDDY_TEXT_ATTACHMENT_EXTENSIONS)

export function toImageReference(record: AttachmentRecord): AttachmentImageReference {
  return { attachmentId: record.id, mimeType: record.mimeType }
}

export function toDocumentReference(record: AttachmentRecord): AttachmentDocumentReference {
  if (!isDocumentMimeType(record.mimeType))
    throw new AttachmentError('VALIDATION_FAILED')
  return { attachmentId: record.id, mimeType: record.mimeType }
}

export function getDocumentKind(mimeType: string): 'pdf' | 'audio' | 'video' {
  const kind = getAttachmentKind(mimeType)
  if (kind !== 'pdf' && kind !== 'audio' && kind !== 'video')
    throw new AttachmentError('VALIDATION_FAILED')
  return kind
}

export function validateTotalBytes(
  sizes: readonly number[],
  limit = BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT,
  errorCode = 'VALIDATION_FAILED',
): void {
  if (sizes.reduce((total, size) => total + size, 0) > limit)
    throw new AttachmentError(errorCode)
}

export function normalizeAttachmentMetadata(input: { mimeType: string, name: string, sizeBytes: number }) {
  const name = input.name.trim()
  const mimeType = extname(name).toLowerCase() === '.pdf' || Object.hasOwn(BUDDY_MEDIA_EXTENSIONS, extname(name).toLowerCase()) || textExtensions.has(extname(name).slice(1).toLowerCase())
    ? inferMimeType(name)
    : input.mimeType.trim() || inferMimeType(name)
  if (!name || /[/\\\0]/.test(name) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
    throw new AttachmentError('VALIDATION_FAILED')
  if (!isDocumentMimeType(mimeType) && !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) && !isTextAttachmentMimeType(mimeType))
    throw new AttachmentError('ATTACHMENT_UNSUPPORTED')
  const byteLimit = isTextAttachmentMimeType(mimeType)
    ? BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT
    : isDocumentMimeType(mimeType) && mimeType !== 'application/pdf'
      ? BUDDY_MEDIA_FILE_BYTES_LIMIT
      : BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT
  if (input.sizeBytes > byteLimit)
    throw new AttachmentError('ATTACHMENT_TOO_LARGE')
  if (isDocumentMimeType(mimeType) && input.sizeBytes === 0)
    throw new AttachmentError('ATTACHMENT_INVALID')
  return { mimeType, name, sizeBytes: input.sizeBytes }
}

export function inferMimeType(path: string): string {
  const extension = extname(path).toLowerCase()
  return MIME_TYPES[extension] ?? (textExtensions.has(extension.slice(1)) ? 'text/plain' : 'application/octet-stream')
}
