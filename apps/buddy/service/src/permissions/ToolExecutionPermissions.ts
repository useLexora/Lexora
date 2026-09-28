import type { BuddyExtensionRunContext } from '../agent/extensions/BuddyExtensionRunContext'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { PermissionPath } from './permissionContract'
import { dirname } from 'node:path'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { classifyPath, PathClassificationError } from './classifyPath'
import { createSensitivePathMatcher } from './sensitivePaths'

export interface ToolExecutionPermissionChange {
  readonly revision: number
  readonly runId: string
  readonly toolCallId?: string
  readonly kind: 'granted' | 'cleared'
  readonly count: number
}

export class ToolExecutionPermissions {
  readonly #runs = new Map<BuddyExtensionRunContext, Map<string, readonly DirectoryGrant[]>>()
  readonly #changes = new Emitter<ToolExecutionPermissionChange>(() => console.error('TOOL_PERMISSION_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #disposed = false
  readonly #releases = new Map<BuddyExtensionRunContext, () => void>()
  readonly #sensitive = createSensitivePathMatcher()

  async authorize(run: BuddyExtensionRunContext, toolCallId: string, input: {
    cwd: string
    grants: readonly DirectoryGrant[]
    paths: readonly PermissionPath[]
    reviewedPaths?: readonly { path: string }[]
  }): Promise<void> {
    if (this.#disposed)
      throw new Error('TOOL_PERMISSIONS_STOPPED')
    input = copyEventSnapshot(input)
    const grants: DirectoryGrant[] = []
    for (const [index, path] of input.paths.entries()) {
      run.signal.throwIfAborted()
      const target = await classifyPath({ ...input, ...path, sensitive: this.#sensitive })
      if (input.reviewedPaths && target.canonicalPath !== input.reviewedPaths[index]?.path)
        throw new PathClassificationError('INVALID_PATH')
      if (target.zone !== 'outside')
        continue
      const root = target.isDirectory ? target.canonicalPath : dirname(target.canonicalPath)
      grants.push({ canonicalRoot: root, root, kind: 'granted', grantId: `run:${run.runId}:${toolCallId}:${grants.length}` })
    }
    run.signal.throwIfAborted()
    if (this.#disposed)
      throw new Error('TOOL_PERMISSIONS_STOPPED')
    let calls = this.#runs.get(run)
    if (!calls) {
      calls = new Map()
      this.#runs.set(run, calls)
      const release = () => {
        run.signal.removeEventListener('abort', release)
        this.#releases.delete(run)
        const count = [...this.#runs.get(run)?.values() ?? []].reduce((count, grants) => count + grants.length, 0)
        this.#runs.delete(run)
        this.#changes.fire(Object.freeze({ revision: ++this.#revision, runId: run.runId, kind: 'cleared', count }))
      }
      this.#releases.set(run, release)
      run.signal.addEventListener('abort', release, { once: true })
    }
    if (JSON.stringify(calls.get(toolCallId) ?? []) === JSON.stringify(grants))
      return
    calls.set(toolCallId, copyEventSnapshot(grants))
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, runId: run.runId, toolCallId, kind: 'granted', count: grants.length }))
  }

  release(run: BuddyExtensionRunContext, toolCallId: string): void {
    const calls = this.#runs.get(run)
    const grants = calls?.get(toolCallId)
    if (!grants)
      return
    calls!.delete(toolCallId)
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, runId: run.runId, toolCallId, kind: 'cleared', count: grants.length }))
  }

  dispose(): void {
    this.#disposed = true
    for (const release of this.#releases.values()) release()
    this.#changes.dispose()
  }

  get(run: BuddyExtensionRunContext | null, toolCallId: string): readonly DirectoryGrant[] {
    return run && !run.signal.aborted ? this.#runs.get(run)?.get(toolCallId) ?? [] : []
  }
}
