import { BUDDY_MEDIA_EXTENSIONS } from './attachmentFormats'

export const BUDDY_ATTACHMENT_COUNT_LIMIT = 16
export const BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT = 32 * 1024 * 1024
export const BUDDY_TEXT_ATTACHMENT_BYTES_LIMIT = 1024 * 1024

export const BUDDY_IMAGE_ATTACHMENT_EXTENSIONS = [
  'gif',
  'jpeg',
  'jpg',
  'png',
  'webp',
] as const

export const BUDDY_TEXT_ATTACHMENT_EXTENSIONS = [
  'bash',
  'c',
  'cjs',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'go',
  'graphql',
  'h',
  'hpp',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsonc',
  'jsx',
  'kt',
  'log',
  'md',
  'mjs',
  'py',
  'rs',
  'rst',
  'scss',
  'sh',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'tsv',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
] as const

export const BUDDY_ATTACHMENT_DIALOG_EXTENSIONS = [
  'pdf',
  ...Object.keys(BUDDY_MEDIA_EXTENSIONS).map(extension => extension.slice(1)),
  ...BUDDY_IMAGE_ATTACHMENT_EXTENSIONS,
  ...BUDDY_TEXT_ATTACHMENT_EXTENSIONS,
]

export interface BuddyAttachmentUpload {
  nameSource?: 'file' | 'clipboard'
  sourcePath?: string
  bytes: Uint8Array
  mimeType: string
  name: string
}

export function getAttachmentKind(mimeType: string): 'image' | 'pdf' | 'audio' | 'video' | 'text' {
  if (mimeType === 'application/pdf')
    return 'pdf'
  if (mimeType.startsWith('image/'))
    return 'image'
  if (mimeType.startsWith('audio/'))
    return 'audio'
  if (mimeType.startsWith('video/'))
    return 'video'
  return 'text'
}
