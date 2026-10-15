import type { FileIconThemeContribution, FileIconThemeDocument } from '../../shared/icons/fileIconTheme.ts'
import { posix } from 'node:path'
import { extensionPathSchema } from '../../shared/extensions/extensionPath.ts'
import { fileIconThemeDocumentSchema, normalizeFileIconTheme } from '../../shared/icons/fileIconTheme.ts'

export const FILE_ICON_DOCUMENT_LIMIT = 2 * 1024 * 1024
export const FILE_ICON_ASSET_LIMIT = 256 * 1024
const imageTypes: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

export function fileIconAssetType(path: string): string {
  const type = imageTypes[posix.extname(path).toLowerCase()]
  if (!type)
    throw new Error('EXTENSION_ICON_THEME_ASSET_INVALID')
  return type
}

export function fileIconAssetPaths(themePath: string, document: FileIconThemeDocument): Map<string, string> {
  return new Map(Object.entries(document.iconDefinitions).map(([id, definition]) => {
    const raw = definition.iconPath
    if (raw.includes('\\') || raw.includes(':') || raw.startsWith('/'))
      throw new Error('EXTENSION_ICON_THEME_ASSET_INVALID')
    const path = extensionPathSchema.parse(posix.join(posix.dirname(themePath), raw))
    fileIconAssetType(path)
    return [id, path]
  }))
}

export function readFileIconTheme(bytes: Uint8Array | undefined): FileIconThemeDocument {
  if (!bytes?.length || bytes.length > FILE_ICON_DOCUMENT_LIMIT)
    throw new Error('EXTENSION_ICON_THEME_DOCUMENT_INVALID')
  let input: unknown
  try {
    input = JSON.parse(new TextDecoder().decode(bytes))
  }
  catch { throw new Error('EXTENSION_ICON_THEME_DOCUMENT_INVALID') }
  const result = fileIconThemeDocumentSchema.safeParse(input)
  if (!result.success)
    throw new Error('EXTENSION_ICON_THEME_DOCUMENT_INVALID')
  return normalizeFileIconTheme(result.data)
}

export function validateFileIconThemeFiles(files: ReadonlyMap<string, Uint8Array>, themes: FileIconThemeContribution[]): void {
  for (const theme of themes) {
    const document = readFileIconTheme(files.get(theme.path))
    for (const path of new Set(fileIconAssetPaths(theme.path, document).values())) {
      const bytes = files.get(path)
      if (!bytes?.length || bytes.length > FILE_ICON_ASSET_LIMIT)
        throw new Error('EXTENSION_ICON_THEME_ASSET_INVALID')
    }
  }
}
