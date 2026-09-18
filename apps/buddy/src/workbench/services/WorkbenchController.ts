import type { JsonValue } from '@buddy-shared/workbench/workbenchState'
import type { CommandContext, ResourceRef, SplitDirection, WorkbenchNode, WorkbenchPane, WorkbenchView } from '../common/workbench'
import type { ContributionRegistry } from './ContributionRegistry'
import { createLayout, createPane, mapNode, panes, removePane, resourceKey } from '../common/workbench'
import { ConfigurationService } from './ConfigurationService'
import { ContextKeyService } from './ContextKeyService'

export interface OpenViewOptions {
  signal?: AbortSignal
  paneId?: string
  viewType?: string
  direction?: SplitDirection
  move?: boolean
  duplicate?: boolean
  state?: WorkbenchView['state']
  focus?: boolean
}
export interface ViewClosePlan {
  views?: readonly string[]
  commit?: () => void
  complete?: () => Promise<void>
  cancel?: () => void
}
export type ViewCloseDecision = boolean | ViewClosePlan
export class WorkbenchController {
  layout
  readonly registry: ContributionRegistry
  readonly configuration: ConfigurationService
  readonly contextKeys = new ContextKeyService()
  readonly beforeClose: (view: WorkbenchView, closing?: ReadonlySet<string>) => Promise<ViewCloseDecision>
  readonly #listeners = new Set<() => void>()
  #tail: Promise<unknown> = Promise.resolve()
  #contextView: string | null = null
  #contextFocused = false

  constructor(registry: ContributionRegistry, beforeClose: (view: WorkbenchView, closing?: ReadonlySet<string>) => Promise<ViewCloseDecision> = async () => true, layout = createLayout()) {
    this.layout = layout
    this.registry = registry
    this.configuration = new ConfigurationService(registry)
    this.beforeClose = beforeClose
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get context(): CommandContext {
    const contextView = this.#contextView ? this.layout.views[this.#contextView] : null
    const pane = this.#contextFocused ? null : this.pane(this.layout.activePane)
    const view = contextView ?? (pane?.view ? this.layout.views[pane.view] ?? null : null)
    return { pane, view, values: { ...this.contextKeys.snapshot(), 'focus.area': this.#contextFocused ? 'context' : 'main', 'view.type': view?.type ?? '', 'resource.scheme': view?.resource.scheme ?? '', 'pane.count': panes(this.layout.root).length } }
  }

  pane(id: string): WorkbenchPane | null {
    return panes(this.layout.root).find(pane => pane.id === id) ?? null
  }

  owner(id: string): WorkbenchPane | null {
    return panes(this.layout.root).find(pane => pane.view === id) ?? null
  }

  open(resource: ResourceRef, title: string, options: OpenViewOptions = {}): Promise<string | null> {
    return this.#enqueue(async () => {
      if (options.signal?.aborted)
        return null
      const descriptor = this.registry.resolve(resource, options.viewType)
      const location = descriptor.location ?? 'main'
      const existing = Object.values(this.layout.views).find(view => view.type === descriptor.id && resourceKey(view.resource) === resourceKey(resource)
        && (location === 'main' || !descriptor.multiple || !options.duplicate))
      if (existing && !options.move) {
        if (options.focus !== false)
          this.focus(existing.id)
        return existing.id
      }
      const view: WorkbenchView = existing ?? { id: crypto.randomUUID(), type: descriptor.id, location, resource: structuredClone(resource), title, state: structuredClone(options.state ?? {}) }
      if (location === 'context') {
        this.layout.views[view.id] = view
        if (options.focus !== false)
          this.focus(view.id)
        else
          this.changed()
        return view.id
      }
      const target = this.pane(options.paneId ?? this.layout.activePane) ?? panes(this.layout.root)[0]!
      const source = this.owner(view.id)
      if (source === target) {
        this.activate(target.id)
        return view.id
      }
      if (options.direction && panes(this.layout.root).length >= 16 && !source)
        return null
      const previous = !options.direction && target.view ? this.layout.views[target.view] : null
      const decision = previous ? await this.beforeClose(previous) : true
      if (!decision)
        return null
      const plan = typeof decision === 'object' ? decision : null
      if (options.signal?.aborted) {
        plan?.cancel?.()
        return null
      }
      if (source) {
        source.view = null
        this.#collapse(source)
      }
      const destination = options.direction ? this.#split(target.id, options.direction) : this.pane(target.id)!
      if (previous)
        delete this.layout.views[previous.id]
      this.layout.views[view.id] = this.layout.views[view.id] ?? view
      destination.view = view.id
      this.layout.activePane = destination.id
      this.#contextView = null
      this.#contextFocused = false
      for (const id of plan?.views ?? []) this.#removeView(id)
      plan?.commit?.()
      this.changed()
      await plan?.complete?.()
      return view.id
    })
  }

  activate(paneId: string): void {
    if (!this.pane(paneId))
      return
    if (this.layout.activePane === paneId && !this.#contextFocused)
      return
    this.layout.activePane = paneId
    this.#contextView = null
    this.#contextFocused = false
    this.changed()
  }

  focus(id: string): void {
    const pane = this.owner(id)
    if (pane) {
      this.activate(pane.id)
    }
    else if (this.layout.views[id]?.location === 'context') {
      this.focusContext(id)
    }
  }

  focusContext(id: string | null = null): void {
    if (id && this.layout.views[id]?.location !== 'context')
      return
    if (this.#contextFocused && this.#contextView === id)
      return
    this.#contextFocused = true
    this.#contextView = id
    this.changed()
  }

  move(viewId: string, destination: string, direction?: SplitDirection): Promise<string | null> {
    const view = this.layout.views[viewId]
    return view?.location === 'main'
      ? this.open(view.resource, view.title, { paneId: destination, direction, move: true, viewType: view.type })
      : Promise.resolve(null)
  }

  resize(id: string, ratio: number): void {
    this.resizeMany([{ id, ratio }])
  }

  resizeMany(changes: readonly { id: string, ratio: number }[]): void {
    const ratios = new Map(changes.filter(change => Number.isFinite(change.ratio)).map(change => [change.id, Math.max(0.15, Math.min(0.85, change.ratio))]))
    if (!ratios.size)
      return
    const update = (node: WorkbenchNode): WorkbenchNode => node.kind === 'pane' ? node : { ...node, ratio: ratios.get(node.id) ?? node.ratio, first: update(node.first), second: update(node.second) }
    this.layout.root = update(this.layout.root)
    this.changed()
  }

  updateView(id: string, change: Partial<Pick<WorkbenchView, 'title' | 'state' | 'resource'>>): void {
    const view = this.layout.views[id]
    if (!view)
      return
    this.layout.views[id] = { ...view, ...change }
    this.changed()
  }

  setAuxiliary(key: string, value: JsonValue): void {
    this.layout.auxiliary[key] = value
    this.changed()
  }

  close(id: string): Promise<boolean> {
    return this.closeMany([id])
  }

  closeMany(ids: readonly string[]): Promise<boolean> {
    return this.#enqueue(async () => {
      const plans: ViewClosePlan[] = []
      const targets = new Set(ids)
      try {
        for (const id of ids) {
          const view = this.layout.views[id]
          if (!view)
            continue
          const decision = await this.beforeClose(view, targets)
          if (!decision) {
            plans.forEach(plan => plan.cancel?.())
            return false
          }
          if (typeof decision === 'object') {
            plans.push(decision)
            decision.views?.forEach(target => targets.add(target))
          }
        }
      }
      catch (error) {
        plans.forEach(plan => plan.cancel?.())
        throw error
      }
      for (const target of targets) this.#removeView(target)
      plans.forEach(plan => plan.commit?.())
      this.changed()
      await Promise.all(plans.map(plan => plan.complete?.()))
      return true
    })
  }

  changed(): void {
    for (const listener of this.#listeners) listener()
  }

  #removeView(id: string): void {
    const pane = this.owner(id)
    delete this.layout.views[id]
    if (pane) {
      pane.view = null
      this.#collapse(pane)
    }
    if (this.#contextView === id)
      this.#contextView = null
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.catch(() => {}).then(operation)
    this.#tail = next
    return next
  }

  #split(paneId: string, direction: SplitDirection): WorkbenchPane {
    const next = createPane()
    const before = direction === 'left' || direction === 'up'
    this.layout.root = mapNode(this.layout.root, paneId, node => ({
      kind: 'split',
      id: crypto.randomUUID(),
      ratio: 0.5,
      axis: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
      first: before ? next : node,
      second: before ? node : next,
    }))
    return next
  }

  #collapse(pane: WorkbenchPane): void {
    this.layout.root = removePane(this.layout.root, pane.id) ?? createPane(pane.id)
    if (this.layout.activePane === pane.id)
      this.layout.activePane = panes(this.layout.root)[0]!.id
  }
}
export { restoreWorkbenchLayout } from './restoreWorkbenchLayout'
