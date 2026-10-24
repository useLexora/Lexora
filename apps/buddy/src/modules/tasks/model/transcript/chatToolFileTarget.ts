import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalSpace, LocalSpaceAdditionalDirectory } from '@buddy-shared/spaces/spaceApi'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import { localFileLinkPath } from '@buddy-shared/files/fileLink'
import { getActiveSpaceDirectories } from '@buddy-shared/spaces/spaceApi'

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

export function resolveChatArtifactTarget(artifacts: readonly LocalArtifact[], path: string): LocalArtifact | null {
  const normalized = (localFileLinkPath(path) ?? '').replaceAll('\\', '/').replace(/^\/+([a-z]:\/)/i, '$1').replace(/^(\.\/)+/, '')
  if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..')
    || (/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^[a-z]:\//i.test(normalized))) {
    return null
  }
  const absolute = normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)
  const matches = new Map<string, LocalArtifact>()
  for (const artifact of artifacts) {
    const target = artifact.path.replaceAll('\\', '/')
    const windows = /^[a-z]:\//i.test(target) || target.startsWith('//')
    const candidate = windows ? normalized.toLowerCase() : normalized
    const stored = windows ? target.toLowerCase() : target
    if (absolute ? stored === candidate : stored.endsWith(`/${candidate}`))
      matches.set(artifact.artifactId, artifact)
  }
  return matches.size === 1 ? matches.values().next().value! : null
}

export function resolveChatToolFileTarget(space: LocalSpace | null, path: string): SpaceFileTarget | null {
  if (!space || space.revokedAt || !path || path.includes('\0'))
    return null
  // Relative paths are relative to where the agent works: the primary directory, or the space's own folder without one.
  let directory: LocalSpaceAdditionalDirectory | null = space.primaryDirectory ?? space.workspaceDirectory ?? null
  let relative = cleanChatToolFilePath(path).replaceAll('\\', '/')
  if (relative.startsWith('/') || /^[a-z]:/i.test(relative)) {
    const candidates = getActiveSpaceDirectories(space).flatMap(directory =>
      [directory.canonicalRoot, directory.root].map(root => ({ directory, root: root.replaceAll('\\', '/').replace(/\/+$/, '') })),
    ).sort((left, right) => right.root.length - left.root.length)
    const match = candidates.find(({ root }) => {
      const windows = /^[a-z]:/i.test(root) || root.startsWith('//')
      return (windows ? relative.toLowerCase() : relative).startsWith(`${windows ? root.toLowerCase() : root}/`)
    })
    if (!match)
      return null
    directory = match.directory
    relative = relative.slice(match.root.length + 1)
  }
  if (!directory || directory.revokedAt)
    return null
  const segments = relative.split('/').filter(segment => segment && segment !== '.')
  if (!segments.length || segments.includes('..') || segments[0] === '~' || relative.includes(':'))
    return null
  return { spaceId: space.id, directoryId: directory.id, revision: directory.revision, path: segments.join('/') }
}
