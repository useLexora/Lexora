import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import { getActiveSpaceDirectories } from '@buddy-shared/spaces/spaceApi'

export function artifactFileTarget(space: LocalSpace | null, path: string): SpaceFileTarget | null {
  if (!space || space.revokedAt || !path || path.includes('\0'))
    return null
  const windows = /^[a-z]:[/\\]/i.test(path) || path.startsWith('\\\\') || path.startsWith('//')
  const normalize = (value: string) => (windows ? value.replaceAll('\\', '/').toLowerCase() : value).replace(/\/+$/, '')
  const absolute = normalize(path)
  const directories = getActiveSpaceDirectories(space).flatMap(directory =>
    [directory.canonicalRoot, directory.root].map(root => ({ directory, root: normalize(root) })),
  ).sort((a, b) => b.root.length - a.root.length)
  const match = directories.find(({ root }) => absolute === root || absolute.startsWith(`${root}/`))
  if (!match)
    return null
  const relative = (windows ? path.replaceAll('\\', '/') : path).slice(match.root.length).replace(/^\/+/, '')
  if (relative.split('/').some(segment => segment === '..' || segment === '.'))
    return null
  return { spaceId: space.id, directoryId: match.directory.id, revision: match.directory.revision, path: relative }
}
