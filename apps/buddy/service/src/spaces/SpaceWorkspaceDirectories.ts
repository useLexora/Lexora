import type { SpaceAdditionalDirectoryBindingRecord, SpaceRecord } from '../storage/spaceRepository'
import { mkdirSync, realpathSync } from 'node:fs'
import { spaceWorkspaceDirectoryId } from '../../../shared/spaces/spaceApi'

// A space without a primary directory works in its own folder under the data directory.
// That folder is not a persisted directory grant, so the file manager gets it as a derived directory.
export class SpaceWorkspaceDirectories {
  readonly #workspaceRoot: (spaceId: string) => string
  readonly #canonicalRoots = new Map<string, string>()

  constructor(workspaceRoot: (spaceId: string) => string) {
    this.#workspaceRoot = workspaceRoot
  }

  get(space: Pick<SpaceRecord, 'createdAt' | 'id' | 'primaryDirectory' | 'revokedAt'>): SpaceAdditionalDirectoryBindingRecord | null {
    if (space.revokedAt || space.primaryDirectory)
      return null
    const root = this.#workspaceRoot(space.id)
    let canonicalRoot = this.#canonicalRoots.get(space.id)
    try {
      mkdirSync(root, { mode: 0o700, recursive: true })
      if (!canonicalRoot) {
        canonicalRoot = realpathSync(root)
        this.#canonicalRoots.set(space.id, canonicalRoot)
      }
    }
    catch {
      // An unusable folder only hides this directory; it must not fail the space list.
      return null
    }
    return {
      accessGrantedAt: space.createdAt,
      canonicalRoot,
      createdAt: space.createdAt,
      id: spaceWorkspaceDirectoryId(space.id),
      revision: 1,
      revokedAt: null,
      root,
      spaceId: space.id,
      updatedAt: space.createdAt,
    }
  }
}
