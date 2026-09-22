import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'

export function cleanChatToolFilePath(path: string): string {
  let cleaned = path.trim()
  if (cleaned.startsWith('sandbox:'))
    cleaned = cleaned.slice(8)
  else if (cleaned.startsWith('file:///'))
    cleaned = cleaned.slice(7)
  else if (cleaned.startsWith('file://'))
    cleaned = cleaned.slice(7)
  try {
    cleaned = decodeURIComponent(cleaned)
  }
  catch {}
  return cleaned.split('#')[0]!.split('?')[0]!
}

export function resolveChatToolFileTarget(space: LocalSpace | null, path: string): SpaceFileTarget | null {
  const directory = space?.primaryDirectory
  if (!space || space.revokedAt || !directory || directory.revokedAt || !path || path.includes('\0'))
    return null
  let relative = cleanChatToolFilePath(path).replaceAll('\\', '/')
  if (relative.startsWith('/') || /^[a-z]:/i.test(relative)) {
    const roots = [directory.canonicalRoot, directory.root].map(root => root.replaceAll('\\', '/').replace(/\/+$/, ''))
    const windows = /^[a-z]:/i.test(roots[0]!) || roots[0]!.startsWith('//')
    const root = roots.find(root => (windows ? relative.toLowerCase() : relative)
      .startsWith(`${windows ? root.toLowerCase() : root}/`))
    if (root === undefined)
      return null
    relative = relative.slice(root.length + 1)
  }
  const segments = relative.split('/').filter(segment => segment && segment !== '.')
  if (!segments.length || segments.includes('..') || segments[0] === '~' || relative.includes(':'))
    return null
  return { spaceId: space.id, directoryId: directory.id, revision: directory.revision, path: segments.join('/') }
}
