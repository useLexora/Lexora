import type { JsonValue } from '@buddy-shared/workbench/workbenchState'
import type { CommandContext, ResourceRef, SplitDirection, ViewLocation, WorkbenchNode, WorkbenchPane, WorkbenchView } from '../common/workbench'
import type { ContributionRegistry } from './ContributionRegistry'
import type { PendingWorkbenchView } from './WorkbenchNavigation'
import { matchesWorkbenchContext } from '@buddy-shared/workbench/workbenchContext'
import { createLayout, createPane, mapNode, panes, removePane, resourceKey } from '../common/workbench'
import { ConfigurationService } from './ConfigurationService'
import { ContextKeyService } from './ContextKeyService'
import { WorkbenchInteractions } from './WorkbenchInteractions'
import { WorkbenchNavigation } from './WorkbenchNavigation'

export interface OpenViewOptions {
  signal?: AbortSignal
  paneId?: string
  viewType?: string
  location?: ViewLocation
  placement?: string
  interactionId?: string
  mountInstanceId?: string
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
  readonly interactions = new WorkbenchInteractions(() => this.changed())
  readonly navigation = new WorkbenchNavigation(() => this.changed())
  readonly contextKeys = new ContextKeyService()
  readonly beforeClose: (view: WorkbenchView, closing?: ReadonlySet<string>) => Promise<ViewCloseDecision>
  readonly #listeners = new Set<() => void>()
  readonly #stopRegistry: () => void
  readonly #openRequests = new Map<string, AbortController>()
  #tail: Promise<unknown> = Promise.resolve()
  #contextView: string | null = null
  #contextFocused = false

  constructor(registry: ContributionRegistry, beforeClose: (view: WorkbenchView, closing?: ReadonlySet<string>) => Promise<ViewCloseDecision> = async () => true, layout = createLayout()) {
    this.layout = layout
    this.registry = registry
    this.configuration = new ConfigurationService(registry)
    this.beforeClose = beforeClose
    this.#stopRegistry = registry.subscribe(() => this.changed())
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  matchesViewContext(view: WorkbenchView): boolean {
    const values = this.contextKeys.snapshot()
    return matchesWorkbenchContext(this.registry.views.get(view.type)?.when, values)
      && matchesWorkbenchContext(view.placement ? this.registry.placements.get(view.placement)?.when : undefined, values)
  }

  get context(): CommandContext {
    const contextView = this.#contextView ? this.layout.views[this.#contextView] : null
    const pane = this.#contextFocused ? null : this.pane(this.layout.activePane)
    const view = contextView ?? (pane?.view ? this.layout.views[pane.view] ?? null : null)
    return { pane, view, values: { ...this.contextKeys.snapshot(), 'focus.area': this.#contextFocused ? view?.location ?? 'context' : 'main', 'view.type': view?.type ?? '', 'resource.scheme': view?.resource.scheme ?? '', 'pane.count': panes(this.layout.root).length } }
  }

  pane(id: string): WorkbenchPane | null {
    return panes(this.layout.root).find(pane => pane.id === id) ?? null
  }

  owner(id: string): WorkbenchPane | null {
    return panes(this.layout.root).find(pane => pane.view === id) ?? null
  }

  get renderedViews(): WorkbenchView[] {
    return [...Object.values(this.layout.views), ...[...this.navigation.entries.values()].filter(entry => entry.status === 'loading').map(entry => entry.view)]
  }

  cancelNavigation(): void {
    for (const request of this.#openRequests.values()) request.abort()
    this.navigation.clear()
  }

  dispose(): void {
    this.cancelNavigation()
    this.#stopRegistry()
  }

  async open(resource: ResourceRef, title: string, options: OpenViewOptions = {}): Promise<string | null> {
    if (options.signal?.aborted)
      return null
    const descriptor = this.registry.resolve(resource, options.viewType)
    const location = options.location ?? descriptor.locations[0]
    if (!descriptor.locations.includes(location))
      throw new Error(`View location is unavailable: ${descriptor.id}:${location}`)
    const target = location === 'main' ? this.pane(options.paneId ?? this.layout.activePane) ?? panes(this.layout.root)[0]! : null
    const request = new AbortController()
    if (target) {
      this.#openRequests.get(target.id)?.abort()
      this.navigation.cancel(target.id)
      this.#openRequests.set(target.id, request)
    }
    const signal = options.signal ? AbortSignal.any([options.signal, request.signal]) : request.signal
    options = { ...options, ...(target ? { paneId: target.id } : {}), signal }
    let prepared: PendingWorkbenchView | undefined
    const cancel = () => {
      if (prepared && this.navigation.entries.get(prepared.paneId)?.view.id === prepared.view.id)
        this.navigation.cancel(prepared.paneId)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (descriptor.prepareBeforeOpen && target?.view && !options.direction && !options.placement && !options.interactionId
        && !Object.values(this.layout.views).some(view => view.type === descriptor.id && resourceKey(view.resource) === resourceKey(resource))) {
        prepared = this.navigation.begin(target.id, target.view, {
          id: crypto.randomUUID(),
          type: descriptor.id,
          location,
          resource: structuredClone(resource),
          title,
          state: structuredClone(options.state ?? {}),
        }, options)
        if (!await prepared.ready || signal.aborted)
          return null
      }
      return await this.#enqueue(async () => {
        if (options.signal?.aborted || (options.interactionId && !this.interactions.entries.has(options.interactionId)))
          return null
        if (prepared && (this.pane(prepared.paneId)?.view !== prepared.previousViewId || this.navigation.find(prepared.view.id)?.status !== 'loading'))
          return null
        if (this.registry.views.get(descriptor.id) !== descriptor)
          return null
        const requestedLocation = options.location ?? descriptor.locations[0]
        if (options.placement) {
          const placement = this.registry.placements.get(options.placement)
          if (!placement || placement.viewType !== descriptor.id || placement.location !== requestedLocation || (placement.target === 'workbench.pane' && !this.pane(options.mountInstanceId ?? '')))
            throw new Error('View placement is unavailable')
        }
        const existing = Object.values(this.layout.views).find(view => view.type === descriptor.id && resourceKey(view.resource) === resourceKey(resource) && view.mountInstanceId === options.mountInstanceId && view.interactionId === options.interactionId
          && (requestedLocation === 'main' || !descriptor.multiple || !options.duplicate))
        if (existing && !options.move) {
          if (options.focus !== false)
            this.focus(existing.id)
          return existing.id
        }
        if (options.interactionId && requestedLocation !== 'mount')
          throw new Error('Interactions require a mount')
        const location = existing?.location ?? requestedLocation
        const view: WorkbenchView = existing ?? (prepared ? this.navigation.find(prepared.view.id)?.view : null) ?? { id: crypto.randomUUID(), type: descriptor.id, location, ...(options.interactionId ? { interactionId: options.interactionId } : {}), ...(options.placement ? { placement: options.placement } : {}), ...(options.mountInstanceId ? { mountInstanceId: options.mountInstanceId } : {}), resource: structuredClone(resource), title, state: structuredClone(options.state ?? {}) }
        if (location !== 'main') {
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
        if (options.signal?.aborted || (prepared && this.navigation.find(prepared.view.id)?.status !== 'loading')) {
          plan?.cancel?.()
          return null
        }
        if (source)
          this.#collapse(source)
        const destination = options.direction ? this.#split(target.id, options.direction) : this.pane(target.id)!
        if (previous)
          delete this.layout.views[previous.id]
        this.layout.views[view.id] = this.layout.views[view.id] ?? view
        this.layout.root = mapNode(this.layout.root, destination.id, () => ({ ...destination, view: view.id }))
        if (!prepared || (this.layout.activePane === target.id && !this.#contextFocused)) {
          this.layout.activePane = destination.id
          this.#contextView = null
          this.#contextFocused = false
        }
        for (const id of plan?.views ?? []) this.#removeView(id)
        plan?.commit?.()
        this.changed()
        await plan?.complete?.()
        return view.id
      })
    }
    finally {
      signal.removeEventListener('abort', cancel)
      if (target && this.#openRequests.get(target.id) === request)
        this.#openRequests.delete(target.id)
      if (prepared && this.navigation.find(prepared.view.id)?.status === 'loading')
        cancel()
    }
  }

  removeInteraction(id: string): void {
    this.interactions.remove(id)
    for (const view of Object.values(this.layout.views)) {
      if (view.interactionId === id && view.location === 'mount')
        this.#removeView(view.id)
    }
    this.changed()
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
    else if (this.layout.views[id] && this.layout.views[id].location !== 'main') {
      this.focusContext(id)
    }
  }

  focusContext(id: string | null = null): void {
    if (id && (!this.layout.views[id] || this.layout.views[id].location === 'main'))
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
      ? this.open(view.resource, view.title, { paneId: destination, direction, move: true, viewType: view.type, location: view.location })
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

  updateView(id: string, change: Partial<Pick<WorkbenchView, 'title' | 'state' | 'resource' | 'presentation'>>): void {
    const pending = this.navigation.find(id)
    if (pending) {
      this.navigation.entries.set(pending.paneId, { ...pending, view: { ...pending.view, ...change } })
      this.changed()
      return
    }
    const view = this.layout.views[id]
    if (!view)
      return
    this.layout.views[id] = { ...view, ...change }
    this.changed()
  }

  rebindAuxiliary(id: string, change: Pick<WorkbenchView, 'type' | 'resource' | 'location' | 'title' | 'placement' | 'mountInstanceId'>): void {
    const view = this.layout.views[id]
    if (!view || view.location === 'main' || change.location === 'main' || resourceKey(view.resource) !== resourceKey(change.resource))
      throw new Error('Invalid auxiliary view replacement')
    const descriptor = this.registry.resolve(change.resource, change.type)
    const placement = change.placement ? this.registry.placements.get(change.placement) : null
    if (!descriptor.locations.includes(change.location) || (change.placement && (!placement || placement.viewType !== change.type || placement.location !== change.location)))
      throw new Error('View placement is unavailable')
    this.layout.views[id] = { ...view, ...structuredClone(change) }
    this.changed()
  }

  setAuxiliary(key: string, value: JsonValue): void {
    this.layout.auxiliary[key] = value
    this.changed()
  }

  close(id: string, signal?: AbortSignal): Promise<boolean> {
    return this.closeMany([id], signal)
  }

  closeMany(ids: readonly string[], signal?: AbortSignal): Promise<boolean> {
    return this.#enqueue(async () => {
      if (signal?.aborted)
        return false
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
      if (signal?.aborted) {
        plans.forEach(plan => plan.cancel?.())
        return false
      }
      for (const target of targets) this.#removeView(target)
      plans.forEach(plan => plan.commit?.())
      this.changed()
      await Promise.all(plans.map(plan => plan.complete?.()))
      return true
    })
  }

  changed(): void {
    for (const entry of this.navigation.entries.values()) {
      if (this.pane(entry.paneId)?.view !== entry.previousViewId || !this.registry.views.has(entry.view.type))
        this.navigation.remove(entry.paneId)
    }
    for (const listener of this.#listeners) listener()
  }

  #removeView(id: string): void {
    const pane = this.owner(id)
    delete this.layout.views[id]
    if (pane)
      this.#collapse(pane)
    if (this.#contextView === id) {
      this.#contextView = null
      this.#contextFocused = false
    }
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
    if (!this.pane(pane.id)) {
      for (const view of Object.values(this.layout.views)) {
        if (view.mountInstanceId === pane.id)
          this.#removeView(view.id)
      }
    }
    if (this.layout.activePane === pane.id)
      this.layout.activePane = panes(this.layout.root)[0]!.id
  }
}
export { restoreWorkbenchLayout } from './restoreWorkbenchLayout'
