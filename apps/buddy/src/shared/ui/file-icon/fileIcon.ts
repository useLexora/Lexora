import type { FileIconResource } from '@buddy-shared/icons/fileIconTheme'
import { resolveFileIconDefinition } from '@buddy-shared/icons/fileIconTheme'
import { desktopFileIconSnapshot } from '@/theme/desktopFileIconState'
import { desktopThemeSnapshot } from '@/theme/desktopThemeState'
import { builtinFileIconTheme, builtinIconUrls } from './builtinFileIconTheme'

export function resolveResourceIcon(resource: FileIconResource, appearance = desktopThemeSnapshot.value.active.descriptor.appearance) {
  const active = desktopFileIconSnapshot.value.active
  const builtinResource = { ...resource }
  if (resource.kind === 'file' && resource.path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase().startsWith('.env.'))
    builtinResource.path = '.env'
  const fallbackId = resolveFileIconDefinition(builtinFileIconTheme, builtinResource, appearance) ?? (resource.kind === 'file' ? 'file' : 'folder')
  const fallbackUrl = Object.hasOwn(builtinIconUrls, fallbackId) ? builtinIconUrls[fallbackId]! : builtinIconUrls.file!
  const id = active ? resolveFileIconDefinition(active.document, resource, appearance) : undefined
  return id && active && Object.hasOwn(active.urls, id)
    ? { id, url: active.urls[id]!, fallbackUrl }
    : { id: fallbackId, url: fallbackUrl, fallbackUrl }
}

export function applyIconFallback(event: Event, url: string): void {
  const image = event.target
  if (image instanceof HTMLImageElement && image.getAttribute('src') !== url)
    image.src = url
}

export function resolveFileIconUrl(path: string): string {
  return resolveResourceIcon({ path, kind: 'file' }).url
}
