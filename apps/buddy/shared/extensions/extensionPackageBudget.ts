import { extensionPathSchema } from './extensionPath.ts'

export const EXTENSION_FILE_LIMIT = 64 * 1024 * 1024
export const EXTENSION_ARCHIVE_LIMIT = 128 * 1024 * 1024
export const EXTENSION_EXPANDED_LIMIT = 256 * 1024 * 1024
export const EXTENSION_PACKAGE_ENTRY_LIMIT = 8192
export const EXTENSION_PACKAGE_FILE_LIMIT = 4096
export const EXTENSION_NON_IMAGE_FILE_LIMIT = 512
export const EXTENSION_PACKAGE_INLINE_BYTES = 18 * 1024 * 1024
export const EXTENSION_PACKAGE_INLINE_BASE64_LENGTH = Math.ceil(EXTENSION_PACKAGE_INLINE_BYTES / 3) * 4
export const EXTENSION_PACKAGE_CHUNK_BYTES = 256 * 1024
export const EXTENSION_PACKAGE_CHUNK_BASE64_LENGTH = Math.ceil(EXTENSION_PACKAGE_CHUNK_BYTES / 3) * 4
export const EXTENSION_REVIEW_BYTES_LIMIT = EXTENSION_EXPANDED_LIMIT

export function validateExtensionFileCounts(paths: Iterable<string>): void {
  let count = 0
  let other = 0
  for (const path of paths) {
    count++
    if (!/\.(?:svg|png|jpe?g|webp)$/i.test(path))
      other++
    if (count > EXTENSION_PACKAGE_FILE_LIMIT || other > EXTENSION_NON_IMAGE_FILE_LIMIT)
      throw new Error('EXTENSION_PACKAGE_LIMIT')
  }
}

export function extensionFilesSize(files: ReadonlyMap<string, Uint8Array>): number {
  let size = 0
  for (const bytes of files.values())
    size += bytes.byteLength
  return size
}

export function validateExtensionFiles(files: ReadonlyMap<string, Uint8Array>): void {
  let total = 0
  const names = new Set<string>()
  validateExtensionFileCounts(files.keys())
  for (const [name, bytes] of files) {
    if (!extensionPathSchema.safeParse(name).success || names.has(name.toLowerCase()))
      throw new Error('EXTENSION_UNSAFE_PATH')
    names.add(name.toLowerCase())
    total += bytes.byteLength
    if (bytes.byteLength > EXTENSION_FILE_LIMIT || total > EXTENSION_EXPANDED_LIMIT)
      throw new Error('EXTENSION_PACKAGE_LIMIT')
  }
}

export function validateExtensionArchiveSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0 || size > EXTENSION_ARCHIVE_LIMIT)
    throw new Error('EXTENSION_ARCHIVE_LIMIT')
}
