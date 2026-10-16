import type { ExtensionFileSource } from '../../shared/extensions/extensionResources'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { z } from 'zod'
import { extensionResourceMimeType } from '../../shared/extensions/extensionResources'
import { THEME_ASSET_PROTOCOL, themeArchiveSchema, themeTransportSchema } from '../../shared/theme/themeApi'
import { themeAssetPaths, themeImageSchema } from '../../shared/theme/themeDocument'
import { FileAssetStore } from '../filesystem/FileAssetStore'

const assetSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), mimeType: z.string().min(1).max(80) }).strict()
export const storedThemeSchema = themeArchiveSchema.extend({ assets: z.record(themeImageSchema, assetSchema) }).refine(archive => themeAssetPaths(archive.document).length === Object.keys(archive.assets).length && themeAssetPaths(archive.document).every(path => Object.hasOwn(archive.assets, path)), 'Invalid theme asset references')
export type StoredTheme = z.infer<typeof storedThemeSchema>
export type ThemeAssetSource = ExtensionFileSource
export interface ThemeResourceAccess { signal: AbortSignal, read: (source: ThemeAssetSource) => Promise<Response> }

export class ThemeAssetStore {
  readonly files: FileAssetStore
  constructor(home: string) { this.files = new FileAssetStore(join(home, 'themes', 'assets')) }

  async prepare(raw: unknown, assertCurrent: () => void, access?: ThemeResourceAccess): Promise<StoredTheme> {
    const archive = themeArchiveSchema.parse(themeTransportSchema.parse(raw))
    const assets: StoredTheme['assets'] = {}
    const signal = access?.signal ?? new AbortController().signal
    const paths = themeAssetPaths(archive.document)
    if (Object.keys(archive.assets).some(path => !paths.includes(path)))
      throw new Error('EXTENSION_THEME_ASSET_UNUSED')
    for (const path of paths) {
      const source = archive.assets[path]
      if (!source)
        throw new Error('EXTENSION_THEME_ASSET_MISSING')
      const response = typeof source === 'string'
        ? new Response(Buffer.from(source, 'base64'))
        : access ? await access.read(source) : undefined
      if (!response?.ok || !response.body)
        throw new Error('EXTENSION_THEME_ASSET_UNAVAILABLE')
      try {
        const asset = await this.files.put(response.body, signal, assertCurrent)
        if (!asset.size)
          throw new Error('EXTENSION_THEME_ASSET_INVALID')
        assets[path] = { ...asset, mimeType: extensionResourceMimeType(path.split('.').at(-1)!) }
      }
      finally { await response.body.cancel().catch(() => {}) }
    }
    if (Object.keys(assets).length !== Object.keys(archive.assets).length)
      throw new Error('EXTENSION_THEME_ASSET_UNUSED')
    assertCurrent()
    return { ...archive, assets }
  }

  async verify(archive: StoredTheme): Promise<void> {
    for (const asset of Object.values(archive.assets)) {
      const response = await this.files.response(asset.key, asset.mimeType, new Request('https://theme.invalid/', { method: 'HEAD' }), new AbortController().signal)
      if (Number(response.headers.get('content-length')) !== asset.size)
        throw new Error('EXTENSION_THEME_ASSET_INVALID')
    }
  }

  urls(archive: StoredTheme): Record<string, string> {
    return Object.fromEntries(Object.entries(archive.assets).map(([path, asset]) => [path, `${THEME_ASSET_PROTOCOL}://asset/${asset.key}/${path.split('/').at(-1)}`]))
  }

  async export(archive: StoredTheme): Promise<string> {
    if (Object.values(archive.assets).reduce((sum, asset) => sum + asset.size, 0) > 12 * 1024 * 1024)
      throw new Error('EXTENSION_THEME_EXPORT_LIMIT')
    const assets: Record<string, string> = {}
    for (const [path, asset] of Object.entries(archive.assets)) {
      const response = await this.files.response(asset.key, asset.mimeType, new Request('https://theme.invalid/'), new AbortController().signal)
      assets[path] = Buffer.from(await response.arrayBuffer()).toString('base64')
    }
    const result = { ...archive, assets }
    themeArchiveSchema.parse(result)
    themeTransportSchema.parse(result)
    return JSON.stringify(result, null, 2)
  }

  async response(url: string, request: Request, archives: Iterable<StoredTheme>, signal: AbortSignal): Promise<Response> {
    const parsed = new URL(url)
    const parts = parsed.pathname.slice(1).split('/')
    if (parsed.protocol !== `${THEME_ASSET_PROTOCOL}:` || parsed.hostname !== 'asset' || parts.length !== 2)
      return new Response(null, { status: 404 })
    const asset = [...archives].flatMap(archive => Object.entries(archive.assets)).find(([path, asset]) => asset.key === parts[0] && path.split('/').at(-1) === parts[1])?.[1]
    if (!asset)
      return new Response(null, { status: 404 })
    return this.files.response(asset.key, asset.mimeType, request, signal)
  }
}
