import type { DirectoryGrantMutation } from './DirectoryGrantService'
import type { DirectoryGrant } from './resolveGrantedPath'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export interface SessionDirectoryGrantChange {
  readonly revision: number
  readonly kind: 'applied' | 'cleared'
  readonly count: number
  readonly removedCount: number
}

export class SessionDirectoryGrants {
  readonly #changes = new Emitter<SessionDirectoryGrantChange>(() => console.error('SESSION_GRANT_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #snapshot: readonly Readonly<DirectoryGrant>[]
  #revision = 0
  #disposed = false

  constructor(grants: readonly DirectoryGrant[]) {
    this.#snapshot = copyEventSnapshot(grants)
  }

  get snapshot(): readonly Readonly<DirectoryGrant>[] { return this.#snapshot }

  apply(mutation: DirectoryGrantMutation): void {
    if (this.#disposed)
      throw new Error('SESSION_GRANTS_STOPPED')
    const covered = new Set(mutation.coveredGrantIds)
    const grants = this.#snapshot.filter(grant => !covered.has(grant.grantId))
    if (grants.length === this.#snapshot.length && grants.some(grant => grant.grantId === mutation.grant.id))
      return
    const removedCount = this.#snapshot.length - grants.length
    if (!grants.some(grant => grant.grantId === mutation.grant.id))
      grants.push({ canonicalRoot: mutation.grant.canonicalRoot, grantId: mutation.grant.id, kind: 'granted', root: mutation.grant.root })
    this.#snapshot = copyEventSnapshot(grants)
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, kind: 'applied', count: grants.length, removedCount }))
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    const removedCount = this.#snapshot.length
    this.#snapshot = Object.freeze([])
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, kind: 'cleared', count: 0, removedCount }))
    this.#changes.dispose()
  }
}
