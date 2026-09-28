import type { SandboxDirectoryGrant } from '../../../shared/permissions/shellSandbox'
import type { BuddyExtensionRunContext } from '../agent/extensions/BuddyExtensionRunContext'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import { realpath, stat } from 'node:fs/promises'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { ShellSandboxError } from '../../../shared/permissions/shellSandbox'

export interface SandboxDirectoryPermissionChange {
  readonly revision: number
  readonly runId: string
  readonly kind: 'granted' | 'upgraded' | 'replaced' | 'cleared'
  readonly access?: 'read' | 'write'
  readonly count: number
}

export class SandboxDirectoryPermissions {
  readonly #runs = new Map<BuddyExtensionRunContext, Map<string, SandboxDirectoryGrant>>()

  readonly #changes = new Emitter<SandboxDirectoryPermissionChange>(() => console.error('SANDBOX_PERMISSION_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #disposed = false
  readonly #releases = new Map<BuddyExtensionRunContext, () => void>()

  async grant(run: BuddyExtensionRunContext, grant: SandboxDirectoryGrant): Promise<void> {
    if (this.#disposed)
      throw new Error('SANDBOX_PERMISSIONS_STOPPED')
    run.signal.throwIfAborted()
    grant = copyEventSnapshot({ access: grant.access, path: grant.path, device: grant.device, inode: grant.inode })
    await validateSandboxDirectory(grant)
    run.signal.throwIfAborted()
    if (this.#disposed)
      throw new Error('SANDBOX_PERMISSIONS_STOPPED')
    let grants = this.#runs.get(run)
    if (!grants) {
      grants = new Map()
      this.#runs.set(run, grants)
      const release = () => {
        run.signal.removeEventListener('abort', release)
        this.#releases.delete(run)
        const count = this.#runs.get(run)?.size ?? 0
        this.#runs.delete(run)
        this.#changes.fire(Object.freeze({ revision: ++this.#revision, runId: run.runId, kind: 'cleared', count }))
      }
      this.#releases.set(run, release)
      run.signal.addEventListener('abort', release, { once: true })
    }
    const existing = grants.get(grant.path)
    const sameIdentity = existing?.device === grant.device && existing.inode === grant.inode
    if (sameIdentity && (existing.access === 'write' || existing.access === grant.access))
      return
    grants.set(grant.path, copyEventSnapshot(grant))
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, runId: run.runId, kind: !existing ? 'granted' : sameIdentity ? 'upgraded' : 'replaced', access: grant.access, count: grants.size }))
  }

  dispose(): void {
    this.#disposed = true
    for (const release of this.#releases.values()) release()
    this.#changes.dispose()
  }

  get(run: BuddyExtensionRunContext | null): readonly Readonly<SandboxDirectoryGrant>[] {
    return Object.freeze(run && !run.signal.aborted ? [...this.#runs.get(run)?.values() ?? []] : [])
  }

  getWriteGrants(run: BuddyExtensionRunContext | null): DirectoryGrant[] {
    return this.get(run).filter(grant => grant.access === 'write').map(grant => ({
      canonicalRoot: grant.path,
      grantId: `sandbox:${grant.path}`,
      kind: 'granted',
      root: grant.path,
    }))
  }
}

export async function validateSandboxDirectory(grant: SandboxDirectoryGrant): Promise<void> {
  try {
    const canonical = await realpath(grant.path)
    const metadata = await stat(canonical, { bigint: true })
    if (canonical === grant.path && metadata.isDirectory() && String(metadata.dev) === grant.device && String(metadata.ino) === grant.inode)
      return
  }
  catch {}
  throw new ShellSandboxError('SANDBOX_DIRECTORY_CHANGED')
}
