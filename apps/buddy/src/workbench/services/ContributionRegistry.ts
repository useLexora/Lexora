import type { Cleanup } from '@buddy-shared/lifecycle/DisposableScope'
import type { CommandContext, ResourceRef, ViewDescriptor, WorkbenchCommand } from '../common/workbench'
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

export class ContributionRegistry {
  readonly views = new Map<string, ViewDescriptor>()
  readonly commands = new Map<string, WorkbenchCommand>()
  readonly configurations = new Map<string, WorkbenchConfiguration>()
  readonly themes = new Map<string, WorkbenchTheme>()
  readonly #owners = new Map<string, DisposableScope>()
  readonly #listeners = new Set<() => void>()

  subscribe(listener: () => void): Cleanup {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  register(owner: string, activate: (scope: {
    view: (descriptor: Omit<ViewDescriptor, 'owner'>) => void
    command: (command: WorkbenchCommand) => void
    configuration: (configuration: WorkbenchConfiguration) => void
    theme: (theme: WorkbenchTheme) => void
    cleanup: (cleanup: Cleanup) => void
    signal: AbortSignal
  }) => void): Cleanup {
    if (this.#owners.has(owner))
      throw new Error(`Contribution already registered: ${owner}`)
    const scope = new DisposableScope()
    const add = <T>(map: Map<string, T>, id: string, value: T) => {
      if (map.has(id))
        throw new Error(`Contribution ID conflict: ${id}`)
      map.set(id, value)
      scope.add(() => {
        map.delete(id)
        this.#notify()
      })
    }
    this.#owners.set(owner, scope)
    try {
      activate({
        view: descriptor => add(this.views, descriptor.id, { ...descriptor, owner }),
        command: command => add(this.commands, command.id, command),
        configuration: configuration => add(this.configurations, configuration.id, configuration),
        theme: theme => add(this.themes, theme.id, theme),
        cleanup: cleanup => scope.add(cleanup),
        signal: scope.signal,
      })
    }
    catch (error) {
      this.#owners.delete(owner)
      scope.dispose()
      throw error
    }
    this.#notify()
    return () => {
      if (this.#owners.get(owner) !== scope)
        return
      this.#owners.delete(owner)
      scope.dispose()
    }
  }

  resolve(resource: ResourceRef, preferred?: string): ViewDescriptor {
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

  async execute(id: string, context: CommandContext): Promise<boolean> {
    const command = this.commands.get(id)
    if (!command || (command.enabled && !command.enabled(context)))
      return false
    await command.execute(context)
    return true
  }

  dispose(): void {
    const failures: unknown[] = []
    for (const scope of [...this.#owners.values()].reverse()) {
      try {
        scope.dispose()
      }
      catch (error) {
        failures.push(error)
      }
    }
    this.#owners.clear()
    this.#listeners.clear()
    if (failures.length)
      throw new AggregateError(failures, 'Contribution disposal failed')
  }

  #notify(): void {
    for (const listener of this.#listeners)
      listener()
  }
}
