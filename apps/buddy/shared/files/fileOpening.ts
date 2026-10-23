import { z } from 'zod'

export const fileOpeningLocationSchema = z.enum(['inline', 'standalone'])
export type FileOpeningLocation = z.infer<typeof fileOpeningLocationSchema>
export const fileOpeningExtensionSchema = z.string().max(40).regex(/^\.[a-z0-9][a-z0-9._+-]*$/)
export const fileOpeningChoiceSchema = z.object({
  extension: fileOpeningExtensionSchema,
  location: fileOpeningLocationSchema,
  providerId: z.string().min(1).max(180).nullable(),
}).strict()
export type FileOpeningChoice = z.infer<typeof fileOpeningChoiceSchema>
export const fileOpeningDefaultsSchema = z.record(fileOpeningExtensionSchema, z.object({
  inline: z.string().min(1).max(180).optional(),
  standalone: z.string().min(1).max(180).optional(),
}).strict())
export type FileOpeningDefaults = z.infer<typeof fileOpeningDefaultsSchema>
export interface FileOpeningProvider {
  id: string
  title: string
  titleEn?: string
  extensions: readonly string[]
  locations: readonly FileOpeningLocation[]
  builtin: boolean
  available: boolean
  renderer: string
  extensionId?: string
  extensionName?: string
  viewTypes?: Partial<Record<FileOpeningLocation, string>>
  recommended?: boolean
}
export interface FileOpeningSnapshot {
  providers: FileOpeningProvider[]
  defaults: FileOpeningDefaults
}
export interface FileOpeningReviewChoice extends FileOpeningChoice {
  providerId: string
  title: string
  currentProviderId: string | null
  requestDefault: boolean
}
export const builtinFileOpeningProviders: readonly FileOpeningProvider[] = [
  { id: 'lexora.image', title: '图片预览', titleEn: 'Image preview', extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico'], locations: ['inline', 'standalone'], builtin: true, available: true, renderer: 'image', recommended: true },
  { id: 'lexora.svg', title: 'SVG 预览', titleEn: 'SVG preview', extensions: ['.svg'], locations: ['inline', 'standalone'], builtin: true, available: true, renderer: 'svg', recommended: true },
  { id: 'lexora.markdown', title: 'Markdown 阅读器', titleEn: 'Markdown reader', extensions: ['.md', '.markdown', '.mdown'], locations: ['inline', 'standalone'], builtin: true, available: true, renderer: 'markdown', recommended: true },
  { id: 'lexora.media', title: '媒体播放器', titleEn: 'Media player', extensions: ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac', '.weba', '.mp4', '.m4v', '.webm', '.ogv', '.mov'], locations: ['inline', 'standalone'], builtin: true, available: true, renderer: 'media', recommended: true },
  { id: 'lexora.browser', title: '浏览器', titleEn: 'Browser', extensions: ['.html', '.htm'], locations: ['standalone'], builtin: true, available: true, renderer: 'browser', recommended: true },
  { id: 'lexora.text', title: '文本查看器', titleEn: 'Text viewer', extensions: ['.txt', '.json', '.js', '.ts', '.tsx', '.css', '.scss', '.vue', '.py', '.rs', '.toml', '.yaml', '.yml', '.xml', '.csv', '.tsv', '.html', '.htm', '.svg', '.md', '.markdown', '.mdown'], locations: ['inline', 'standalone'], builtin: true, available: true, renderer: 'text' },
]

export function fileOpeningExtension(name: string, providers: readonly FileOpeningProvider[], retainedExtensions: readonly string[] = []): string | null {
  const filename = (name.split(/[\\/]/).at(-1) ?? '').toLowerCase()
  return [...new Set([...providers.flatMap(provider => provider.extensions), ...retainedExtensions])]
    .filter(extension => filename.endsWith(extension))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0] ?? null
}

export function resolveFileOpening(snapshot: FileOpeningSnapshot, name: string, location: FileOpeningLocation) {
  const providers = snapshot.providers.filter(provider => provider.locations.includes(location))
  const extension = fileOpeningExtension(name, providers, Object.keys(snapshot.defaults).filter(extension => snapshot.defaults[extension]?.[location]))
  const preferredId = extension ? snapshot.defaults[extension]?.[location] ?? null : null
  const candidates = providers.flatMap((provider) => {
    const match = provider.available ? fileOpeningExtension(name, [provider]) : null
    return match ? [{ provider, extension: match }] : []
  }).sort((left, right) => right.extension.length - left.extension.length || Number(Boolean(right.provider.recommended)) - Number(Boolean(left.provider.recommended)) || left.provider.id.localeCompare(right.provider.id)).map(candidate => candidate.provider)
  const preferred = candidates.find(provider => provider.id === preferredId && extension !== null && fileOpeningExtension(extension, [provider]) !== null)
  const builtin = candidates.find(provider => provider.builtin)
  return { extension, preferredId, candidates, provider: preferred ?? builtin ?? null, unavailable: preferredId !== null && !preferred }
}

export function resolveBuiltinFileOpening(name: string, location: FileOpeningLocation) {
  return resolveFileOpening({ providers: [...builtinFileOpeningProviders], defaults: {} }, name, location)
}

export function fileOpeningTitle(provider: FileOpeningProvider, language: string): string {
  return language === 'en-US' ? provider.titleEn ?? provider.title : provider.title
}
