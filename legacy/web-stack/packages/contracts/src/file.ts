export const FILE_SIZE_LIMITS = {
  DOCUMENT_IMAGE: 2 * 1024 * 1024,
  DOCUMENT_FILE: 50 * 1024 * 1024,
  CHAT_IMAGE_ATTACHMENT: 10 * 1024 * 1024,
  CHAT_FILE_ATTACHMENT: 25 * 1024 * 1024,
} as const

export const SUPPORTED_IMAGE_EXTENSION_BY_MIME_TYPE = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

export type SupportedImageMimeType = keyof typeof SUPPORTED_IMAGE_EXTENSION_BY_MIME_TYPE

export const SUPPORTED_IMAGE_MIME_TYPES = Object.keys(
  SUPPORTED_IMAGE_EXTENSION_BY_MIME_TYPE,
) as SupportedImageMimeType[]
