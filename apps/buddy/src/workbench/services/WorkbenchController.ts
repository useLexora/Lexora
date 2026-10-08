import type { EventSnapshot } from '@buddy-shared/events/eventTypes'
import type { ReadonlyJsonValue } from '@buddy-shared/workbench/workbenchState'
import type { CommandContext, ResourceRef, SplitDirection, ViewLocation, WorkbenchLayout, WorkbenchNode, WorkbenchPane, WorkbenchView } from '../common/workbench'
import type { ContributionRegistry } from './ContributionRegistry'
import type { PendingWorkbenchView } from './WorkbenchNavigation'
import { Emitter, filterEvent, mapEvent } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot, freezeEventSnapshot } from '@buddy-shared/events/eventSnapshot'
import { matchesWorkbenchContext } from '@buddy-shared/workbench/workbenchContext'
import { createLayout, createPane, mapNode, panes, removePane, resourceKey } from '../common/workbench'
import { CommandService } from './CommandService'
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
  validate?: () => boolean
  prepareAuxiliary?: (current: Readonly<Record<string, ReadonlyJsonValue>>) => Readonly<Record<string, ReadonlyJsonValue>>
  complete?: (commit: { revision: number }) => void | Promise<void>
  cancel?: () => void
}
export type ViewCloseDecision = boolean | ViewClosePlan
export type ViewCloseResult = { readonly committed: false, readonly status: 'cancelled' | 'stale' }
  | { readonly committed: true, readonly status: 'closed' | 'cleanup-pending', readonly revision: number, readonly views: readonly string[], readonly failures: readonly unknown[] }
export interface WorkbenchLayoutChange {
  readonly revision: number
  readonly kind: 'opened' | 'moved' | 'closed' | 'updated' | 'resized' | 'activated' | 'auxiliary' | 'restored' | 'interaction-removed'
  readonly changedViewIds: readonly string[]
  readonly removedViewIds: readonly string[]
  readonly snapshot: EventSnapshot<WorkbenchLayout>
}
export interface WorkbenchFocusChange {
  readonly revision: number
  readonly context: CommandContext
}
export type WorkbenchChange = { readonly type: 'layout', readonly change: WorkbenchLayoutChange }
  | { readonly type: 'focus', readonly change: WorkbenchFocusChange }
  | { readonly type: 'context' | 'contributions' | 'navigation' | 'interaction', readonly revision: number }
interface PreparedClose {
  plans: ViewClosePlan[]
  targets: Map<string, WorkbenchView>
  auxiliary: WorkbenchLayout['auxiliary']
  layoutRevision: number
}

export class WorkbenchController {
  #layout: WorkbenchLayout
  readonly registry: ContributionRegistry
  readonly configuration: ConfigurationService
  readonly commands: CommandService
  readonly interactions = new WorkbenchInteractions()
  readonly navigation = new WorkbenchNavigation()
  readonly contextKeys = new ContextKeyService()
  readonly #beforeClose: (view: WorkbenchView, closing?: ReadonlySet<string>) => Promise<ViewCloseDecision>
  readonly #changes = new Emitter<WorkbenchChange>(() => console.error('WORKBENCH_OBSERVER_FAILED'))
  readonly #closeResults = new Emitter<ViewCloseResult>(() => console.error('WORKBENCH_CLOSE_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly onDidChangeLayout = mapEvent(filterEvent(this.onDidChange, (event): event is Extract<WorkbenchChange, { type: 'layout' }> => event.type === 'layout'), event => event.change)
  readonly onDidChangeFocus = mapEvent(filterEvent(this.onDidChange, (event): event is Extract<WorkbenchChange, { type: 'focus' }> => event.type === 'focus'), event => event.change)
  readonly onDidSettleClose = this.#closeResults.event
  readonly #subscriptions: (() => void)[]
  readonly #openRequests = new Map<string, AbortController>()
  readonly #completions = new Set<Promise<ViewCloseResult>>()
  #tail: Promise<unknown> = Promise.resolve()
  #contextView: string | null = null
  #contextFocused = false
  #layoutRevision = 0
  #revision = 0
  #invokingBeforeClose = false
  #disposed = false
  #stopping = false
  #disposal: Promise<void> | undefined

  constructor(registry: ContributionRegistry, beforeClose: (view: WorkbenchView, closing?: ReadonlySet<string>) => Promise<ViewCloseDecision> = async () => true, layout = createLayout(), readonly canOpenResource: (resource: ResourceRef) => boolean = () => true) {
    this.#layout = copyEventSnapshot(layout)
    this.registry = registry
    this.configuration = new ConfigurationService(registry)
    this.commands = new CommandService(registry, (input) => {
      if (this.#stopping)
        return null
      const context = this.context
      if (!input.paneId)
        return { ...context, source: input.source, arguments: input.arguments }
      const pane = this.pane(input.paneId)
      if (!pane)
        return null
      const view = pane.view ? this.#layout.views[pane.view] ?? null : null
      return { pane, view, source: input.source, arguments: input.arguments, values: { ...this.contextKeys.snapshot(), 'focus.area': 'main', 'view.type': view?.type ?? '', 'resource.scheme': view?.resource.scheme ?? '', 'pane.count': panes(this.#layout.root).length } }
    })
    this.#beforeClose = beforeClose
    this.#subscriptions = [
      registry.onDidChange(() => {
        this.#reconcileNavigation()
        this.#notify('contributions')
      }).dispose,
      this.contextKeys.onDidChange(() => this.#notify('context')).dispose,
      this.navigation.onDidChange(() => this.#notify('navigation')).dispose,
      this.interactions.onDidChange(() => this.#notify('interaction')).dispose,
    ]
  }

  get layout(): EventSnapshot<WorkbenchLayout> { return this.#layout }
  get layoutRevision(): number { return this.#layoutRevision }
  get revision(): number { return this.#revision }

  subscribe(listener: () => void): () => void { return this.onDidChange(listener).dispose }

  restoreLayout(layout: WorkbenchLayout): void {
    if (this.#stopping)
      return
    const next = copyEventSnapshot(layout)
    this.#commit('restored', () => {
      this.#layout = next
      this.#contextView = null
      this.#contextFocused = false
    })
  }

  matchesViewContext(view: WorkbenchView): boolean {
    const values = this.contextKeys.snapshot()
    return matchesWorkbenchContext(this.registry.views.get(view.type)?.when, values)
      && matchesWorkbenchContext(view.placement ? this.registry.placements.get(view.placement)?.when : undefined, values)
  }

  get context(): CommandContext {
    const contextView = this.#contextView ? this.#layout.views[this.#contextView] : null
    const pane = this.#contextFocused ? null : this.pane(this.#layout.activePane)
    const view = contextView ?? (pane?.view ? this.#layout.views[pane.view] ?? null : null)
    return copyEventSnapshot({ pane, view, values: { ...this.contextKeys.snapshot(), 'focus.area': this.#contextFocused ? view?.location ?? 'context' : 'main', 'view.type': view?.type ?? '', 'resource.scheme': view?.resource.scheme ?? '', 'pane.count': panes(this.#layout.root).length } })
  }

  pane(id: string): WorkbenchPane | null {
    return panes(this.#layout.root).find(pane => pane.id === id) ?? null
  }

  owner(id: string): WorkbenchPane | null {
    return panes(this.#layout.root).find(pane => pane.view === id) ?? null
  }

  get renderedViews(): WorkbenchView[] {
    return [...Object.values(this.#layout.views), ...[...this.navigation.entries.values()].filter(entry => entry.status === 'loading').map(entry => entry.view)]
  }

  cancelNavigation(): void {
    for (const request of this.#openRequests.values()) request.abort()
    this.navigation.clear()
  }

  stop(): void {
    if (this.#stopping)
      return
    this.#stopping = true
    this.commands.stop()
    this.cancelNavigation()
  }

  dispose(): Promise<void> {
    this.stop()
    this.#disposal ??= this.#dispose()
    return this.#disposal
  }

  async #dispose(): Promise<void> {
    await this.commands.dispose()
    await this.settle()
    this.#disposed = true
    const failures: unknown[] = []
    for (const release of [
      ...this.#subscriptions,
      () => this.navigation.dispose(),
      () => this.interactions.dispose(),
      () => this.contextKeys.dispose(),
      () => this.configuration.dispose(),
      () => this.#changes.dispose(),
      () => this.#closeResults.dispose(),
    ]) {
      try {
        release()
      }
      catch (error) {
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'WORKBENCH_DISPOSAL_FAILED')
  }

  async settle(): Promise<void> {
    await this.#tail.catch(() => {})
    while (this.#completions.size)
      await Promise.allSettled([...this.#completions])
  }

  async open(resource: ResourceRef, title: string, options: OpenViewOptions = {}): Promise<string | null> {
    if (this.#stopping || options.signal?.aborted || !this.canOpenResource(resource))
      return null
    if (this.#invokingBeforeClose)
      throw new Error('WORKBENCH_CLOSE_PREPARATION_IN_PROGRESS')
    resource = copyEventSnapshot(resource)
    options = { ...options, ...(options.state ? { state: copyEventSnapshot(options.state) } : {}) }
    const descriptor = this.registry.resolve(resource, options.viewType)
    const location = options.location ?? descriptor.locations[0]
    if (!descriptor.locations.includes(location))
      throw new Error(`View location is unavailable: ${descriptor.id}:${location}`)
    const target = location === 'main' ? this.pane(options.paneId ?? this.#layout.activePane) ?? panes(this.#layout.root)[0]! : null
    const request = new AbortController()
    if (target) {
      this.#openRequests.get(target.id)?.abort()
      this.navigation.cancel(target.id)
      this.#openRequests.set(target.id, request)
    }
    const signal = options.signal ? AbortSignal.any([options.signal, request.signal]) : request.signal
    options = { ...options, ...(target ? { paneId: target.id } : {}), signal }
    let completion: Promise<ViewCloseResult> | undefined
    let prepared: PendingWorkbenchView | undefined
    const cancel = () => {
      if (prepared && this.navigation.entries.get(prepared.paneId)?.view.id === prepared.view.id)
        this.navigation.cancel(prepared.paneId)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (descriptor.prepareBeforeOpen && target?.view && !options.direction && !options.placement && !options.interactionId
        && !Object.values(this.#layout.views).some(view => view.type === descriptor.id && resourceKey(view.resource) === resourceKey(resource))) {
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
      const opened = await this.#enqueue(async () => {
        if (this.#stopping || options.signal?.aborted || !this.canOpenResource(resource) || (options.interactionId && !this.interactions.entries.has(options.interactionId)))
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
        const existing = Object.values(this.#layout.views).find(view => view.type === descriptor.id && resourceKey(view.resource) === resourceKey(resource) && view.mountInstanceId === options.mountInstanceId && view.interactionId === options.interactionId
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
          this.#commit('opened', () => {
            this.#layout.views[view.id] = view
            if (options.focus !== false) {
              this.#contextFocused = true
              this.#contextView = view.id
            }
          })
          return view.id
        }
        const target = this.pane(options.paneId ?? this.#layout.activePane) ?? panes(this.#layout.root)[0]!
        const source = this.owner(view.id)
        if (source?.id === target.id) {
          this.activate(target.id)
          return view.id
        }
        if (options.direction && panes(this.#layout.root).length >= 16 && !source)
          return null
        const previous = !options.direction && target.view ? this.#layout.views[target.view] : null
        const close = await this.#prepareClose(previous ? [previous.id] : [], options.signal)
        if (!close)
          return null
        if (this.#stopping || options.signal?.aborted || !this.canOpenResource(resource) || !this.#valid(close)
          || this.registry.views.get(descriptor.id) !== descriptor
          || this.pane(target.id)?.view !== target.view
          || (prepared && this.navigation.find(prepared.view.id)?.status !== 'loading')) {
          this.#cancel(close)
          return null
        }
        const revision = this.#commit(options.move ? 'moved' : 'opened', () => {
          if (source)
            this.#collapse(source)
          const destination = options.direction ? this.#split(target.id, options.direction) : this.pane(target.id)!
          for (const id of close.targets.keys()) {
            if (id !== previous?.id)
              this.#removeView(id)
          }
          if (previous)
            delete this.#layout.views[previous.id]
          this.#layout.views[view.id] = this.#layout.views[view.id] ?? view
          this.#layout.root = mapNode(this.#layout.root, destination.id, () => ({ ...destination, view: view.id }))
          if (!prepared || (this.#layout.activePane === target.id && !this.#contextFocused)) {
            this.#layout.activePane = destination.id
            this.#contextView = null
            this.#contextFocused = false
          }
          this.#applyAuxiliary(close)
        })
        completion = this.#complete(close, revision)
        return view.id
      })
      await completion
      return opened
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
    const views = Object.values(this.#layout.views).filter(view => view.interactionId === id && view.location === 'mount')
    if (views.length)
      this.#commit('interaction-removed', () => { for (const view of views) this.#removeView(view.id) })
    this.interactions.remove(id)
  }

  activate(paneId: string): void {
    if (!this.pane(paneId) || (this.#layout.activePane === paneId && !this.#contextFocused))
      return
    this.#commit('activated', () => {
      this.#layout.activePane = paneId
      this.#contextView = null
      this.#contextFocused = false
    })
  }

  focus(id: string): void {
    const pane = this.owner(id)
    if (pane)
      this.activate(pane.id)
    else if (this.#layout.views[id] && this.#layout.views[id].location !== 'main')
      this.focusContext(id)
  }

  focusContext(id: string | null = null): void {
    if (id && (!this.#layout.views[id] || this.#layout.views[id].location === 'main'))
      return
    if (this.#contextFocused && this.#contextView === id)
      return
    this.#commit('activated', () => {
      this.#contextFocused = true
      this.#contextView = id
    })
  }

  move(viewId: string, destination: string, direction?: SplitDirection): Promise<string | null> {
    const view = this.#layout.views[viewId]
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
    const update = (node: WorkbenchNode): WorkbenchNode => {
      if (node.kind === 'pane')
        return node
      const ratio = ratios.get(node.id) ?? node.ratio
      const first = update(node.first)
      const second = update(node.second)
      return ratio === node.ratio && first === node.first && second === node.second ? node : { ...node, ratio, first, second }
    }
    this.#commit('resized', () => {
      this.#layout.root = update(this.#layout.root)
    })
  }

  updateView(id: string, change: Partial<Pick<WorkbenchView, 'title' | 'state' | 'resource' | 'presentation'>>): void {
    const pending = this.navigation.find(id)
    if (pending) {
      this.navigation.update(id, change)
      return
    }
    const view = this.#layout.views[id]
    if (!view)
      return
    if (JSON.stringify({ ...view, ...change }) === JSON.stringify(view))
      return
    this.#commit('updated', () => {
      this.#layout.views[id] = copyEventSnapshot({ ...view, ...change })
    })
  }

  // Called only after the filesystem commit, with dirty-copy decisions already settled.
  commitFileMutation(changes: readonly { id: string, resource: ResourceRef, title: string }[], removed: readonly string[] = []): void {
    this.#commit(removed.length ? 'closed' : 'updated', () => {
      for (const id of removed) this.#removeView(id)
      for (const change of changes) {
        const view = this.#layout.views[change.id]
        if (view)
          this.#layout.views[change.id] = copyEventSnapshot({ ...view, resource: change.resource, title: change.title })
      }
    })
  }

  rebindAuxiliary(id: string, change: Pick<WorkbenchView, 'type' | 'resource' | 'location' | 'title' | 'placement' | 'mountInstanceId'>): void {
    const view = this.#layout.views[id]
    if (!view || view.location === 'main' || change.location === 'main' || resourceKey(view.resource) !== resourceKey(change.resource))
      throw new Error('Invalid auxiliary view replacement')
    const descriptor = this.registry.resolve(change.resource, change.type)
    const placement = change.placement ? this.registry.placements.get(change.placement) : null
    if (!descriptor.locations.includes(change.location) || (change.placement && (!placement || placement.viewType !== change.type || placement.location !== change.location)))
      throw new Error('View placement is unavailable')
    this.#commit('updated', () => {
      this.#layout.views[id] = copyEventSnapshot({ ...view, ...change })
    })
  }

  setAuxiliary(key: string, value: ReadonlyJsonValue): void {
    if (JSON.stringify(this.#layout.auxiliary[key]) === JSON.stringify(value))
      return
    this.#commit('auxiliary', () => {
      this.#layout.auxiliary[key] = copyEventSnapshot(value)
    })
  }

  removeAuxiliary(key: string): void {
    if (Object.hasOwn(this.#layout.auxiliary, key)) {
      this.#commit('auxiliary', () => {
        delete this.#layout.auxiliary[key]
      })
    }
  }

  close(id: string, signal?: AbortSignal): Promise<ViewCloseResult> { return this.closeMany([id], signal) }

  async closeMany(ids: readonly string[], signal?: AbortSignal): Promise<ViewCloseResult> {
    let completion: Promise<ViewCloseResult> | undefined
    const result = await this.#enqueue(async (): Promise<ViewCloseResult | null> => {
      if (this.#stopping || signal?.aborted)
        return { committed: false, status: 'cancelled' }
      const prepared = await this.#prepareClose(ids, signal)
      if (!prepared)
        return { committed: false, status: 'cancelled' }
      if (this.#stopping || signal?.aborted || !this.#valid(prepared)) {
        this.#cancel(prepared)
        return { committed: false, status: 'stale' }
      }
      const revision = this.#commit('closed', () => {
        for (const id of prepared.targets.keys()) this.#removeView(id)
        this.#applyAuxiliary(prepared)
      })
      completion = this.#complete(prepared, revision)
      return null
    })
    return result ?? await completion!
  }

  async #prepareClose(ids: readonly string[], signal?: AbortSignal): Promise<PreparedClose | null> {
    const prepared: PreparedClose = { plans: [], targets: new Map(), auxiliary: this.#layout.auxiliary, layoutRevision: this.#layoutRevision }
    const targets = new Set(ids)
    try {
      for (const id of targets) {
        if (signal?.aborted || this.#stopping) {
          this.#cancel(prepared)
          return null
        }
        const view = this.#layout.views[id]
        if (!view)
          continue
        prepared.targets.set(id, view)
        let preparation: Promise<ViewCloseDecision>
        this.#invokingBeforeClose = true
        try {
          preparation = this.#beforeClose(view, targets)
        }
        finally { this.#invokingBeforeClose = false }
        const decision = await preparation
        if (!decision) {
          this.#cancel(prepared)
          return null
        }
        if (typeof decision === 'object') {
          prepared.plans.push(decision)
          for (const target of decision.views ?? []) targets.add(target)
        }
      }
      prepared.layoutRevision = this.#layoutRevision
      prepared.auxiliary = this.#layout.auxiliary
      for (const plan of prepared.plans) {
        if (plan.prepareAuxiliary)
          prepared.auxiliary = copyEventSnapshot(plan.prepareAuxiliary(prepared.auxiliary))
      }
      return prepared
    }
    catch (error) {
      this.#cancel(prepared)
      throw error
    }
  }

  #valid(prepared: PreparedClose): boolean {
    try {
      if ([...prepared.targets.values()].some(view => !this.canOpenResource(view.resource)))
        return false
      if (prepared.plans.some(plan => plan.validate && !plan.validate()))
        return false
      return prepared.layoutRevision === this.#layoutRevision && [...prepared.targets].every(([id, view]) => this.#layout.views[id] === view)
    }
    catch {
      return false
    }
  }

  #cancel(prepared: PreparedClose): void {
    for (const plan of [...prepared.plans].reverse()) {
      try {
        plan.cancel?.()
      }
      catch {
        console.error('WORKBENCH_CLOSE_CANCEL_FAILED')
      }
    }
  }

  #applyAuxiliary(prepared: PreparedClose): void {
    this.#layout.auxiliary = prepared.auxiliary
  }

  #complete(prepared: PreparedClose, revision: number): Promise<ViewCloseResult> {
    const views = Object.freeze([...prepared.targets.keys()])
    const completion = Promise.resolve().then(async (): Promise<ViewCloseResult> => {
      const results = await Promise.allSettled(prepared.plans.map(async plan => plan.complete?.({ revision })))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      const result = Object.freeze({ committed: true as const, status: failures.length ? 'cleanup-pending' as const : 'closed' as const, revision, views, failures: Object.freeze(failures) })
      this.#closeResults.fire(result)
      return result
    })
    this.#completions.add(completion)
    void completion.finally(() => this.#completions.delete(completion))
    return completion
  }

  #commit(kind: WorkbenchLayoutChange['kind'], mutate: () => void): number {
    if (this.#disposed || (this.#stopping && kind !== 'auxiliary'))
      return this.#layoutRevision
    const previous = this.#layout
    const focus = this.context
    this.#layout = { ...previous, views: { ...previous.views }, auxiliary: { ...previous.auxiliary } }
    try {
      mutate()
    }
    catch (error) {
      this.#layout = previous
      this.#contextFocused = focus.values['focus.area'] !== 'main'
      this.#contextView = this.#contextFocused ? focus.view?.id ?? null : null
      throw error
    }
    this.#layout = freezeEventSnapshot(this.#layout)
    const changedViewIds = Object.keys(this.#layout.views).filter(id => this.#layout.views[id] !== previous.views[id])
    const removedViewIds = Object.keys(previous.views).filter(id => !this.#layout.views[id])
    const auxiliaryChanged = [...new Set([...Object.keys(previous.auxiliary), ...Object.keys(this.#layout.auxiliary)])].some(key => previous.auxiliary[key] !== this.#layout.auxiliary[key])
    const changes: WorkbenchChange[] = []
    if (previous.root !== this.#layout.root || previous.activePane !== this.#layout.activePane || changedViewIds.length || removedViewIds.length || auxiliaryChanged || kind === 'restored') {
      changes.push({ type: 'layout', change: Object.freeze({ revision: ++this.#layoutRevision, kind, changedViewIds: Object.freeze(changedViewIds), removedViewIds: Object.freeze(removedViewIds), snapshot: this.#layout }) })
      this.#revision++
    }
    const context = this.context
    if (context.view?.id !== focus.view?.id || context.pane?.id !== focus.pane?.id || context.values['focus.area'] !== focus.values['focus.area'])
      changes.push({ type: 'focus', change: Object.freeze({ revision: ++this.#revision, context }) })
    const revision = this.#layoutRevision
    this.#changes.fireBatch(changes.map(change => Object.freeze(change)))
    this.#reconcileNavigation()
    return revision
  }

  #notify(type: 'context' | 'contributions' | 'navigation' | 'interaction'): void {
    this.#changes.fire(Object.freeze({ type, revision: ++this.#revision }))
  }

  #reconcileNavigation(): void {
    for (const entry of this.navigation.entries.values()) {
      if (this.pane(entry.paneId)?.view !== entry.previousViewId || !this.registry.views.has(entry.view.type))
        this.navigation.remove(entry.paneId)
    }
  }

  #removeView(id: string): void {
    const pane = this.owner(id)
    delete this.#layout.views[id]
    if (pane)
      this.#collapse(pane)
    if (this.#contextView === id) {
      this.#contextView = null
      this.#contextFocused = false
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#invokingBeforeClose)
      return Promise.reject(new Error('WORKBENCH_CLOSE_PREPARATION_IN_PROGRESS'))
    const next = this.#tail.catch(() => {}).then(operation)
    this.#tail = next
    return next
  }

  #split(paneId: string, direction: SplitDirection): WorkbenchPane {
    const next = createPane()
    const before = direction === 'left' || direction === 'up'
    this.#layout.root = mapNode(this.#layout.root, paneId, node => ({
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
    this.#layout.root = removePane(this.#layout.root, pane.id) ?? createPane(pane.id)
    if (!this.pane(pane.id)) {
      for (const view of Object.values(this.#layout.views)) {
        if (view.mountInstanceId === pane.id)
          this.#removeView(view.id)
      }
    }
    if (this.#layout.activePane === pane.id)
      this.#layout.activePane = panes(this.#layout.root)[0]!.id
  }
}
export { restoreWorkbenchLayout } from './restoreWorkbenchLayout'
