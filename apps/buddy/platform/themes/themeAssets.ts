import { Buffer } from 'node:buffer'
import { themeArchiveSchema, themeTransportSchema } from '../../shared/theme/themeApi.ts'
import { themeAssetPaths, themeDocumentSchema } from '../../shared/theme/themeDocument.ts'
import { EXTENSION_FILE_LIMIT, EXTENSION_PACKAGE_LIMIT } from '../extensions/extensionLimits.ts'

const imageTypes: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export function themeAssetUrl(path: string, bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > EXTENSION_FILE_LIMIT)
    throw new Error('EXTENSION_THEME_ASSET_INVALID')
  return `data:${imageTypes[path.split('.').at(-1)!.toLowerCase()]};base64,${Buffer.from(bytes).toString('base64')}`
}

export function validateThemeArchive(input: unknown) {
  const archive = themeArchiveSchema.parse(themeTransportSchema.parse(input))
  let total = 0
  const assets: Record<string, string> = {}
  for (const path of themeAssetPaths(archive.document)) {
    const encoded = archive.assets[path]
    if (!encoded)
      throw new Error('EXTENSION_THEME_ASSET_MISSING')
    const bytes = Buffer.from(encoded, 'base64')
    total += bytes.length
    if (total > EXTENSION_PACKAGE_LIMIT)
      throw new Error('EXTENSION_PACKAGE_LIMIT')
    assets[path] = themeAssetUrl(path, bytes)
  }
  if (Object.keys(assets).length !== Object.keys(archive.assets).length)
    throw new Error('EXTENSION_THEME_ASSET_UNUSED')
  return { archive, assets }
}

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
      themeAssetUrl(path, image)
    }
  }
}
