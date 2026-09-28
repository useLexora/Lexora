import type { ListenerErrorHandler } from '@buddy-shared/events/Emitter'
import type { EventSnapshot } from '@buddy-shared/events/eventTypes'
import type { Cleanup } from '@buddy-shared/lifecycle/DisposableScope'
import type { ResourceRef, ViewDescriptor, ViewPlacement, WorkbenchCommand } from '../common/workbench'
import { Emitter } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'
import { ReadonlyMapView } from '@buddy-shared/events/ReadonlyMapView'
import { DisposableScope } from '@buddy-shared/lifecycle/DisposableScope'

export interface WorkbenchConfiguration {
  id: string
  defaultValue: boolean | number | string
  validate: (value: unknown) => boolean
}
export interface WorkbenchTheme {
  id: string
  colorScheme: 'light' | 'dark'
  tokens: Readonly<Record<string, string>>
}

export interface ContributionChange {
  readonly revision: number
  readonly owner: string
  readonly kind: 'registered' | 'removed'
  readonly ids: Readonly<Record<'views' | 'placements' | 'commands' | 'configurations' | 'themes', readonly string[]>>
}

interface Registration {
  scope: DisposableScope
  entries: Map<Map<string, unknown>, Map<string, unknown>>
  ids: ContributionChange['ids']
  committed: boolean
}

export class ContributionRegistry {
  readonly #views = new Map<string, EventSnapshot<ViewDescriptor>>()
  readonly #placements = new Map<string, EventSnapshot<ViewPlacement>>()
  readonly #commands = new Map<string, EventSnapshot<WorkbenchCommand>>()
  readonly #configurations = new Map<string, EventSnapshot<WorkbenchConfiguration>>()
  readonly #themes = new Map<string, EventSnapshot<WorkbenchTheme>>()
  readonly views = new ReadonlyMapView(this.#views)
  readonly placements = new ReadonlyMapView(this.#placements)
  readonly commands = new ReadonlyMapView(this.#commands)
  readonly configurations = new ReadonlyMapView(this.#configurations)
  readonly themes = new ReadonlyMapView(this.#themes)
  readonly #owners = new Map<string, Registration>()
  readonly #changes: Emitter<ContributionChange>
  readonly onDidChange
  #revision = 0
  #disposed = false

  constructor(onListenerError: ListenerErrorHandler = () => console.error('CONTRIBUTION_OBSERVER_FAILED')) {
    this.#changes = new Emitter(onListenerError)
    this.onDidChange = this.#changes.event
  }

  get revision(): number { return this.#revision }

  subscribe(listener: () => void): Cleanup {
    return this.onDidChange(listener).dispose
  }

  register(owner: string, activate: (scope: {
    view: (descriptor: Omit<ViewDescriptor, 'owner'>) => void
    placement: (placement: ViewPlacement) => void
    command: (command: WorkbenchCommand) => void
    configuration: (configuration: WorkbenchConfiguration) => void
    theme: (theme: WorkbenchTheme) => void
    cleanup: (cleanup: Cleanup) => void
    signal: AbortSignal
  }) => void): Cleanup {
    if (this.#disposed)
      throw new Error('CONTRIBUTION_REGISTRY_DISPOSED')
    if (this.#owners.has(owner))
      throw new Error(`Contribution already registered: ${owner}`)
    const scope = new DisposableScope()
    const staged = new Map<Map<string, unknown>, Map<string, unknown>>()
    const ids = { views: [] as string[], placements: [] as string[], commands: [] as string[], configurations: [] as string[], themes: [] as string[] }
    const registration: Registration = { scope, entries: staged, ids, committed: false }
    const add = <T>(kind: keyof typeof ids, map: Map<string, EventSnapshot<T>>, id: string, value: T) => {
      if (scope.signal.aborted || registration.committed)
        throw new Error('CONTRIBUTION_REGISTRATION_CLOSED')
      const entries = staged.get(map) ?? new Map<string, unknown>()
      staged.set(map, entries)
      if (map.has(id) || entries.has(id))
        throw new Error(`Contribution ID conflict: ${id}`)
      entries.set(id, copyEventSnapshot(value))
      ids[kind].push(id)
    }
    this.#owners.set(owner, registration)
    try {
      activate({
        view: descriptor => add('views', this.#views, descriptor.id, { ...descriptor, owner }),
        placement: placement => add('placements', this.#placements, placement.id, placement),
        command: command => add('commands', this.#commands, command.id, command),
        configuration: configuration => add('configurations', this.#configurations, configuration.id, configuration),
        theme: theme => add('themes', this.#themes, theme.id, theme),
        cleanup: cleanup => scope.add(cleanup),
        signal: scope.signal,
      })
      if (this.#disposed || scope.signal.aborted)
        throw new Error('CONTRIBUTION_REGISTRATION_CLOSED')
      for (const [map, entries] of staged) {
        for (const id of entries.keys()) {
          if (map.has(id))
            throw new Error(`Contribution ID conflict: ${id}`)
        }
      }
    }
    catch (error) {
      this.#owners.delete(owner)
      try {
        scope.dispose()
      }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Contribution registration failed') }
      throw error
    }
    for (const [map, entries] of staged) {
      for (const [id, value] of entries) map.set(id, value)
    }
    registration.committed = true
    this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, owner, kind: 'registered', ids }))
    return () => this.#remove(owner, registration)
  }

  resolve(resource: ResourceRef, preferred?: string): EventSnapshot<ViewDescriptor> {
    if (preferred) {
      const descriptor = this.views.get(preferred)
      if (!descriptor || !descriptor.supports(resource))
        throw new Error(`Resource view is unavailable: ${preferred}`)
      return descriptor
    }
    const candidates = [...this.views.values()].filter(view => view.supports(resource)).sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id))
    if (!candidates.length)
      throw new Error(`No view for resource: ${resource.scheme}`)
    return candidates[0]!
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    const failures: unknown[] = []
    for (const [owner, registration] of [...this.#owners].reverse()) {
      try {
        this.#remove(owner, registration)
      }
      catch (error) {
        failures.push(error)
      }
    }
    this.#changes.dispose()
    if (failures.length)
      throw new AggregateError(failures, 'Contribution disposal failed')
  }

  #remove(owner: string, registration: Registration): void {
    if (this.#owners.get(owner) !== registration)
      return
    this.#owners.delete(owner)
    for (const [map, entries] of registration.entries) {
      for (const [id, value] of entries) {
        if (map.get(id) === value)
          map.delete(id)
      }
    }
    if (registration.committed)
      this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, owner, kind: 'removed', ids: registration.ids }))
    registration.scope.dispose()
  }
}
