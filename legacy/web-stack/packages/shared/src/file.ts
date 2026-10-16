import type { SupportedImageMimeType } from '@haohaoxue/lexora-contracts/file'
import { SUPPORTED_IMAGE_EXTENSION_BY_MIME_TYPE } from '@haohaoxue/lexora-contracts/file'

export const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

export type ByteUnits = typeof BYTE_UNITS[number]

export interface PrettyBytesOptions {
  precision?: number
  compatible?: boolean
}

const FILE_EXTENSION_PREFIX = /^\./
const SAFE_FILE_EXTENSION_PATTERN = /^[a-z0-9]{1,16}$/
const TEXT_LIKE_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/typescript',
  'application/sql',
  'application/x-ndjson',
  'application/x-sh',
])
const TEXT_LIKE_FILE_EXTENSIONS = new Set([
  'c',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'go',
  'h',
  'html',
  'java',
  'js',
  'json',
  'jsonl',
  'jsx',
  'log',
  'md',
  'mdx',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
])

export function getBytes(num: number, unit: ByteUnits, compatible = false): number {
  const exponent = BYTE_UNITS.indexOf(unit)

  if (exponent < 0) {
    return num
  }

  return num * getByteBase(compatible) ** exponent
}

export function prettyBytes(num: number, options: PrettyBytesOptions = {}): string {
  const { compatible = false } = options
  const base = getByteBase(compatible)
  const precision = normalizePrecision(options.precision)

  if (Math.abs(num) < 1) {
    return `${num}${BYTE_UNITS[0]}`
  }

  const exponent = Math.min(
    Math.floor(Math.log(Math.abs(num)) / Math.log(base)),
    BYTE_UNITS.length - 1,
  )
  const result = Number((num / base ** exponent).toFixed(precision))

  return `${result}${BYTE_UNITS[exponent]}`
}

export function normalizeFileMimeType(mimeType: string): string {
  return mimeType.trim().toLowerCase() || 'application/octet-stream'
}

export function isSupportedImageMimeType(mimeType: string): mimeType is SupportedImageMimeType {
  return mimeType.trim().toLowerCase() in SUPPORTED_IMAGE_EXTENSION_BY_MIME_TYPE
}

export function normalizeSupportedImageMimeType(mimeType: string): SupportedImageMimeType | null {
  const normalized = normalizeFileMimeType(mimeType)
  return isSupportedImageMimeType(normalized) ? normalized : null
}

export function resolveSupportedImageExtension(mimeType: SupportedImageMimeType): string {
  return SUPPORTED_IMAGE_EXTENSION_BY_MIME_TYPE[mimeType]
}

export function isImageSignatureMatched(bytes: Uint8Array, mimeType: SupportedImageMimeType): boolean {
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF
  }

  if (mimeType === 'image/png') {
    return bytes.length >= 8
      && bytes[0] === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4E
      && bytes[3] === 0x47
      && bytes[4] === 0x0D
      && bytes[5] === 0x0A
      && bytes[6] === 0x1A
      && bytes[7] === 0x0A
  }

  if (mimeType === 'image/gif') {
    return bytes.length >= 6
      && (asciiPrefix(bytes, 6) === 'GIF87a' || asciiPrefix(bytes, 6) === 'GIF89a')
  }

  return bytes.length >= 12
    && asciiPrefix(bytes, 4) === 'RIFF'
    && asciiSlice(bytes, 8, 12) === 'WEBP'
}

export function resolveSafeFileExtension(fileName: string, fallback = ''): string {
  const baseName = fileName
    .trim()
    .split(/[\\/]/u)
    .at(-1)
    ?? ''
  const dotIndex = baseName.lastIndexOf('.')
  const extension = dotIndex > 0
    ? baseName.slice(dotIndex + 1).replace(FILE_EXTENSION_PREFIX, '').trim().toLowerCase()
    : ''

  if (SAFE_FILE_EXTENSION_PATTERN.test(extension)) {
    return extension
  }

  return fallback
}

export function isTextLikeMimeType(mimeType: string): boolean {
  const normalized = normalizeFileMimeType(mimeType)
  return normalized.startsWith('text/')
    || TEXT_LIKE_MIME_TYPES.has(normalized)
    || normalized.endsWith('+json')
    || normalized.endsWith('+xml')
}

export function isTextLikeFile(input: {
  fileName?: string | null
  mimeType?: string | null
}): boolean {
  const mimeType = input.mimeType?.trim() ?? ''
  if (mimeType && isTextLikeMimeType(mimeType)) {
    return true
  }

  const extension = input.fileName ? resolveSafeFileExtension(input.fileName) : ''
  return Boolean(extension && TEXT_LIKE_FILE_EXTENSIONS.has(extension))
}

function getByteBase(compatible: boolean) {
  return compatible ? 1000 : 1024
}

function normalizePrecision(value: number | undefined) {
  if (value === undefined) {
    return 2
  }

  if (!Number.isFinite(value)) {
    return 2
  }

  return Math.min(Math.max(Math.trunc(value), 0), 20)
}

function asciiPrefix(bytes: Uint8Array, length: number): string {
  return asciiSlice(bytes, 0, length)
}

function asciiSlice(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}
