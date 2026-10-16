import type { StorageContentDisposition } from './storage.interface'

const STORAGE_CONTENT_DISPOSITION_DEFAULT_FILE_NAME = {
  inline: 'file',
  attachment: 'attachment',
} as const

const STORAGE_CONTENT_DISPOSITION_NON_ASCII_RE = /[^\x20-\x7E]/
const STORAGE_CONTENT_DISPOSITION_NON_ASCII_GLOBAL_RE = /[^\x20-\x7E]/g

export function buildStorageContentDisposition(input: StorageContentDisposition): string {
  const normalizedFileName = resolveStorageContentDispositionFileName(input)
  const asciiFileName = normalizedFileName.replace(STORAGE_CONTENT_DISPOSITION_NON_ASCII_GLOBAL_RE, '_')
  const baseValue = `${input.type}; filename="${asciiFileName}"`

  if (!STORAGE_CONTENT_DISPOSITION_NON_ASCII_RE.test(normalizedFileName)) {
    return baseValue
  }

  return `${baseValue}; filename*=UTF-8''${encodeStorageContentDispositionFileName(normalizedFileName)}`
}

function resolveStorageContentDispositionFileName(input: StorageContentDisposition): string {
  const fileName = normalizeStorageContentDispositionFileName(input.fileName)

  if (fileName) {
    return fileName
  }

  return normalizeStorageContentDispositionFileName(input.fallbackFileName)
    || STORAGE_CONTENT_DISPOSITION_DEFAULT_FILE_NAME[input.type]
}

function normalizeStorageContentDispositionFileName(fileName: string | undefined): string {
  return Array.from(fileName?.trim() ?? '').filter(isStorageContentDispositionFileNameCharacter).join('')
}

function encodeStorageContentDispositionFileName(fileName: string): string {
  return encodeURIComponent(fileName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function isStorageContentDispositionFileNameCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0

  return codePoint > 0x1F
    && codePoint !== 0x7F
    && character !== '"'
    && character !== '\\'
    && character !== '/'
}
