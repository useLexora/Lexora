import type { SpaceFileMutation, SpaceFileMutationResult, SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { WorkspaceFileMutationGuard } from './WorkspaceFileMutationGuard'
import type { WorkspaceEntryChange, WorkspaceMutationResult } from '@/modules/tasks/contracts'
import type { ResourceRef } from '@/workbench/common/workbench'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { resourceInFileScope } from './WorkspaceFileMutationGuard'

export type DirtyFileChoice = 'save' | 'discard' | 'cancel'

export function renamedFileResource(resource: ResourceRef, source: SpaceFileTarget, path: string): ResourceRef {
  const next = path + String(resource.data.path).slice(source.path.length)
  return { ...resource, id: JSON.stringify([source.directoryId, source.revision, next]), data: { ...resource.data, path: next } }
}

export class WorkspaceFileOperations {
  constructor(readonly options: {
    guard: WorkspaceFileMutationGuard
    copies: WorkingCopyService
    controller: WorkbenchController
    mutate: (input: SpaceFileMutation) => Promise<SpaceFileMutationResult>
    confirmDirty: (paths: readonly string[]) => Promise<DirtyFileChoice>
    retain: (resource: ResourceRef) => () => void
    flush: () => Promise<void>
    changed: (change: WorkspaceEntryChange) => void
    synchronize: (target: SpaceFileTarget, renamedPath?: string) => void
    report: (error: unknown) => void
  }) {}

  async mutate(input: SpaceFileMutation): Promise<WorkspaceMutationResult> {
    const { guard, copies, controller } = this.options
    if (input.operation !== 'rename' && input.operation !== 'trash') {
      const createdPath = input.path ? `${input.path}/${input.name}` : input.name
      if (!guard.allowed({ scheme: 'file', id: '', data: { ...input } }) || !guard.allowed({ scheme: 'file', id: '', data: { ...input, path: createdPath } }))
        return { status: 'failed', reason: 'busy' }
      const result = await this.options.mutate(input)
      if (result.status === 'completed' || result.reason === 'result-unknown')
        this.options.changed({ target: input })
      return result
    }
    const parent = input.path.includes('/') ? input.path.slice(0, input.path.lastIndexOf('/') + 1) : ''
    const destination = input.operation === 'rename' ? { ...input, path: parent + input.name } : undefined
    if (destination?.path === input.path)
      return { status: 'cancelled' }
    // Pending opens are not migrated. They must finish before capturing the stable set.
    const release = guard.acquire(input, () => [...controller.navigation.entries.values()].map(entry => entry.view.resource), destination)
    if (!release)
      return { status: 'failed', reason: 'busy' }
    const matches = (resource: ResourceRef) => resourceInFileScope(resource, input) || (!!destination && resourceInFileScope(resource, destination))
    const holds: (() => void)[] = []
    let uncertain = false
    const lease = copies.beginMutation(matches)
    if (!lease) {
      release()
      return { status: 'failed', reason: 'busy' }
    }
    try {
      if (destination && ([...copies.copies.values()].some(copy => resourceInFileScope(copy.resource, destination))
        || controller.renderedViews.some(view => resourceInFileScope(view.resource, destination)))) {
        return { status: 'failed', reason: 'destination-open' }
      }
      const affected = [...copies.copies.values()].filter(copy => resourceInFileScope(copy.resource, input))
      const views = Object.values(controller.layout.views).filter(view => resourceInFileScope(view.resource, input))
      for (const copy of affected) holds.push(this.options.retain(copy.resource))
      const dirty = affected.filter(copy => copy.dirty)
      if (input.operation === 'trash' && dirty.length) {
        const choice = await this.options.confirmDirty(dirty.map(copy => String(copy.resource.data.path)))
        if (choice === 'cancel')
          return { status: 'cancelled' }
        if (choice === 'save') {
          for (const copy of dirty) {
            const result = await lease.save(copy.resource)
            if (result.status === 'conflict')
              return { status: 'failed', reason: 'save-conflict' }
            if ((result.status !== 'saved' && result.status !== 'unchanged') || result.dirtyAfter)
              return { status: 'failed', reason: 'save-failed' }
          }
        }
      }
      // Persist recovery contents before touching disk. A failure here is still reversible.
      await this.options.flush()
      let result: SpaceFileMutationResult
      try {
        result = await this.options.mutate(input)
      }
      catch { result = { status: 'failed', reason: 'result-unknown' } }
      if (result.status === 'failed') {
        uncertain = result.reason === 'result-unknown'
        if (uncertain)
          this.options.changed({ target: input, removedPath: input.path })
        return result
      }
      // From here disk has changed: never report an ordinary retryable failure or restore old paths.
      uncertain = true
      if (input.operation === 'rename') {
        const moves = affected.map(copy => ({ from: copy.resource, to: renamedFileResource(copy.resource, input, result.path) }))
        for (const move of moves) holds.push(this.options.retain(move.to))
        lease.relocate(moves)
        controller.commitFileMutation(views.map((view) => {
          const resource = renamedFileResource(view.resource, input, result.path)
          return { id: view.id, resource, title: String(resource.data.path).split('/').at(-1)! }
        }))
      }
      else {
        controller.commitFileMutation([], views.map(view => view.id))
        for (const copy of affected) lease.remove(copy.resource)
      }
      this.options.synchronize(input, input.operation === 'rename' ? result.path : undefined)
      this.options.changed({ target: input, removedPath: input.path })
      uncertain = false
      release()
      lease.release()
      // A persistence error does not undo a successful filesystem mutation.
      await this.options.flush().catch(this.options.report)
      return result
    }
    catch (error) {
      this.options.report(error)
      return { status: 'failed', reason: uncertain ? 'result-unknown' : 'failed' }
    }
    finally {
      // Unknown outcomes retain the write fence and all recovery contents, not a writable old path.
      if (!uncertain) {
        release()
        lease.release()
        for (const hold of holds) hold()
      }
    }
  }
}
