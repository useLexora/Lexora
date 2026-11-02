import type { ComputedRef, InjectionKey } from 'vue'

// Maps an image address as the Markdown parser reports it (percent-encoded) to a URL the app can load, or null to keep it as written.
export type MarkdownImageResolver = (src: string) => string | null

export const markdownImageResolverKey: InjectionKey<ComputedRef<MarkdownImageResolver | undefined>> = Symbol('markdownImageResolver')

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i
const DRIVE_PREFIX = /^[a-z]:[\\/]/i

// The path an image points at when its address is relative to the document that contains it.
// A relative document path (a file inside a root) stays relative and never climbs above that root; an absolute one keeps its drive and separator style.
export function documentRelativePath(documentPath: string, src: string): string | null {
  if (!src || URL_SCHEME.test(src) || /^[#?/\\]/.test(src) || documentPath.startsWith('\\\\'))
    return null
  let relative: string
  try {
    relative = decodeURIComponent(src.split(/[?#]/, 1)[0]!)
  }
  catch { return null }
  if (!relative || relative.includes('\0'))
    return null

  const drive = DRIVE_PREFIX.test(documentPath) ? documentPath.slice(0, 2) : ''
  const absolute = drive !== '' || documentPath.startsWith('/')
  const separator = drive !== '' && documentPath.includes('\\') ? '\\' : '/'
  const segments = documentPath.slice(drive.length).split(/[\\/]/).filter(Boolean)
  segments.pop()
  for (const part of relative.split(/[\\/]/)) {
    if (part === '' || part === '.')
      continue
    if (part !== '..') {
      segments.push(part)
      continue
    }
    if (!segments.length)
      return null
    segments.pop()
  }
  if (!segments.length)
    return null
  const path = segments.join(separator)
  return absolute ? `${drive}${separator}${path}` : path
}
