import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { ResourceRef } from '@/workbench/common/workbench'
import { pathInFileScope } from '@buddy-shared/spaces/spaceFileNames'

export function resourceInFileScope(resource: ResourceRef, target: SpaceFileTarget): boolean {
  if (resource.scheme !== 'file' && resource.scheme !== 'file-preview')
    return false
  const data = resource.data
  return data.spaceId === target.spaceId && data.directoryId === target.directoryId && data.revision === target.revision
    && typeof data.path === 'string' && pathInFileScope(data.path, target.path)
}

// Local synchronous gate, not a scheduler. The same predicate is checked by editor and view entry points.
export class WorkspaceFileMutationGuard {
  readonly #targets = new Set<SpaceFileTarget>()
  allowed(resource: ResourceRef): boolean {
    return ![...this.#targets].some(target => resourceInFileScope(resource, target))
  }

  acquire(target: SpaceFileTarget, resources: () => readonly ResourceRef[], destination?: SpaceFileTarget): (() => void) | null {
    if ([...this.#targets].some(other => other.directoryId === target.directoryId))
      return null
    const captured = { ...target }
    this.#targets.add(captured)
    try {
      if (resources().some(resource => resourceInFileScope(resource, captured))) {
        this.#targets.delete(captured)
        return null
      }
    }
    catch (error) {
      this.#targets.delete(captured)
      throw error
    }
    const next = destination ? { ...destination } : null
    if (next)
      this.#targets.add(next)
    return () => {
      this.#targets.delete(captured)
      if (next)
        this.#targets.delete(next)
    }
  }
}
