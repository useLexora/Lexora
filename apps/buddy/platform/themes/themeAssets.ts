import { Buffer } from 'node:buffer'
import { themeAssetPaths, themeDocumentSchema } from '../../shared/theme/themeDocument.ts'
import { EXTENSION_FILE_LIMIT } from '../extensions/extensionLimits.ts'

export function validateThemeFiles(files: ReadonlyMap<string, Uint8Array>, themes: Array<{ path: string }>): void {
  for (const theme of themes) {
    const bytes = files.get(theme.path)
    if (!bytes || bytes.length > 256 * 1024)
      throw new Error('EXTENSION_THEME_DOCUMENT_MISSING')
    const document = themeDocumentSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
    for (const path of themeAssetPaths(document)) {
      const image = files.get(path)
      if (!image)
        throw new Error('EXTENSION_THEME_ASSET_MISSING')
      if (!image.length || image.length > EXTENSION_FILE_LIMIT)
        throw new Error('EXTENSION_THEME_ASSET_INVALID')
    }
  }
}
