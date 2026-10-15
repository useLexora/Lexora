export const EXTENSION_FILE_LIMIT = 4 * 1024 * 1024
export const EXTENSION_PACKAGE_LIMIT = 16 * 1024 * 1024
export const EXTENSION_PACKAGE_ENTRY_LIMIT = 8192
export const EXTENSION_PACKAGE_FILE_LIMIT = 4096
export const EXTENSION_NON_IMAGE_FILE_LIMIT = 512

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
