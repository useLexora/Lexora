import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { SpaceFileMutation, SpaceFileOperation, SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { ResourceRef } from '@/workbench/common/workbench'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { spaceFileTargetSchema } from '@buddy-shared/spaces/spaceFileApi'
import { shallowRef } from 'vue'
import { resourceKey } from '@/workbench/common/workbench'

interface Options {
  api: Pick<LocalChatApi['spaces'], 'mutateFile'>
  spaces: () => readonly LocalSpace[]
  writeClipboardText: (text: string) => Promise<void>
  copies: WorkingCopyService
  controller: WorkbenchController
  flush: () => Promise<unknown>
  confirmSave: (paths: readonly string[]) => Promise<boolean>
  updateSelection: (source: string, destination: string | null) => void
}

export class FileOperationService {
  readonly clipboard = shallowRef<{ target: SpaceFileTarget, move: boolean } | null>(null)
  readonly #options: Options
  #pending: Promise<unknown> = Promise.resolve()
  #stopped = false

  constructor(options: Options) { this.#options = options }

  execute(input: SpaceFileMutation): Promise<SpaceFileOperation | null> {
    if (this.#stopped)
      return Promise.reject(new Error('FILE_OPERATIONS_STOPPED'))
    const snapshot = JSON.parse(JSON.stringify(input)) as SpaceFileMutation
    const pending = this.#pending.catch(() => {}).then(() => this.#execute(snapshot))
    this.#pending = pending
    return pending
  }

  async copyPath(target: SpaceFileTarget): Promise<void> {
    if (this.#stopped)
      throw new Error('FILE_OPERATIONS_STOPPED')
    const path = absolute(this.root(target), target.path)
    await this.#options.writeClipboardText(/^[a-z]:\//i.test(path) || path.startsWith('//') ? path.replaceAll('/', '\\') : path)
  }

  async dispose(): Promise<void> {
    this.#stopped = true
    await this.#pending.catch(() => {})
  }

  root(target: SpaceFileTarget): string {
    const directory = this.#options.spaces().find(space => space.id === target.spaceId)?.primaryDirectory
    if (!directory || directory.id !== target.directoryId || directory.revision !== target.revision || directory.revokedAt)
      throw new Error('FILE_PERMISSION_REVOKED')
    return directory.canonicalRoot
  }

  #physical(resource: ResourceRef): string | null {
    if (resource.scheme !== 'file' && resource.scheme !== 'file-preview')
      return null
    const parsed = spaceFileTargetSchema.strip().safeParse(resource.data)
    if (!parsed.success)
      return null
    try {
      return absolute(typeof resource.data.canonicalRoot === 'string' ? resource.data.canonicalRoot : this.root(parsed.data), parsed.data.path)
    }
    catch { return null }
  }

  #relocate(resource: ResourceRef, source: string, destination: string, target: SpaceFileTarget): ResourceRef {
    const path = this.#physical(resource)!
    const nextPath = destination + path.slice(source.length)
    const oldTarget = spaceFileTargetSchema.strip().parse(resource.data)
    const oldRoot = typeof resource.data.canonicalRoot === 'string' ? resource.data.canonicalRoot : this.root(oldTarget)
    const sameRoot = contains(absolute(oldRoot, ''), nextPath)
    const nextTarget = sameRoot ? { ...oldTarget, path: relative(absolute(oldRoot, ''), nextPath) } : { ...target, path: `${target.path}${path.slice(source.length)}` }
    return { scheme: resource.scheme, id: JSON.stringify([nextTarget.directoryId, nextTarget.revision, nextTarget.path]), data: { ...spaceFileTargetSchema.strip().parse(nextTarget), canonicalRoot: sameRoot ? oldRoot : this.root(target) } }
  }

  async #execute(input: SpaceFileMutation): Promise<SpaceFileOperation | null> {
    const { copies, controller, api } = this.#options
    const source = absolute(this.root(input), input.path)
    const action = input.action
    const target = action.kind === 'rename'
      ? { ...input, path: action.destination }
      : action.kind === 'move' || action.kind === 'copy' ? action.destination : null
    const destination = target ? absolute(this.root(target), target.path) : null
    const changesSource = action.kind === 'rename' || action.kind === 'move' || action.kind === 'trash'
    const affected = (resource: ResourceRef) => {
      const path = this.#physical(resource)
      return path !== null && ((changesSource && contains(source, path)) || (destination !== null && contains(destination, path)))
    }
    const release = copies.guard(affected)
    let released = false
    const unlock = () => {
      if (!released) {
        released = true
        release()
      }
    }
    try {
      await copies.settle(affected)
      if (destination && target && changesSource) {
        const targets = new Set<string>()
        for (const copy of copies.copies.values()) {
          const path = this.#physical(copy.resource)
          if (!path || !contains(source, path))
            continue
          const key = resourceKey(this.#relocate(copy.resource, source, destination, target))
          if (targets.has(key))
            throw new Error('FILE_VIEW_CONFLICT')
          targets.add(key)
        }
      }
      const dirty = [...copies.copies.values()].filter(copy => affected(copy.resource) && copy.dirty)
      if (dirty.length && !await this.#options.confirmSave(dirty.map(copy => String(copy.resource.data.path))))
        return null
      for (const copy of dirty) {
        const saved = await copies.save(copy.resource, true)
        if ((saved.status !== 'saved' && saved.status !== 'unchanged') || saved.dirtyAfter)
          throw new Error('FILE_UNSAVED_CONFLICT')
      }
      if (destination && changesSource && [...copies.copies.values()].some((copy) => {
        const path = this.#physical(copy.resource)
        return path !== null && contains(destination, path) && !contains(source, path)
      })) {
        throw new Error('FILE_VIEW_CONFLICT')
      }
      await this.#options.flush()
      const result = await api.mutateFile(input)
      if (result.status !== 'applied')
        return result
      if (changesSource) {
        const resources = new Map<string, ResourceRef>()
        for (const copy of copies.copies.values()) resources.set(copy.key, copy.resource)
        for (const view of Object.values(controller.layout.views)) resources.set(resourceKey(view.resource), view.resource)
        const closed: string[] = []
        for (const [key, resource] of resources) {
          const path = this.#physical(resource)
          if (!path || !contains(source, path))
            continue
          const views = Object.values(controller.layout.views).filter(view => resourceKey(view.resource) === key)
          if (destination && target) {
            const next = this.#relocate(resource, source, destination, target)
            const nextPath = String(next.data.path)
            if (copies.get(resource))
              copies.move(resource, next)
            for (const view of views) controller.updateView(view.id, { resource: next, title: nextPath.split('/').at(-1) ?? nextPath })
          }
          else {
            closed.push(...views.map(view => view.id))
          }
        }
        this.#options.updateSelection(source, destination)
        unlock()
        if (closed.length)
          await controller.closeMany(closed)
      }
      await this.#options.flush()
      return result
    }
    finally { unlock() }
  }
}

export function absolute(root: string, path: string): string {
  const value = `${root.replaceAll('\\', '/').replace(/\/$/, '')}${path ? `/${path}` : ''}`
  return value
}
export function contains(root: string, path: string): boolean {
  if (/^[a-z]:\//i.test(root) || root.startsWith('//')) {
    root = root.toLowerCase()
    path = path.toLowerCase()
  }
  return root === path || path.startsWith(`${root}/`)
}
function relative(root: string, path: string): string {
  return path.slice(root.length + 1)
}
