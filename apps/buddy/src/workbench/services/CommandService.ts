import type { ListenerErrorHandler } from '@buddy-shared/events/Emitter'
import type { CommandContext } from '../common/workbench'
import type { ContributionRegistry } from './ContributionRegistry'
import { Emitter } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'

export interface CommandInvocation {
  source?: CommandContext['source']
  arguments?: string
  paneId?: string
}
export interface CommandExecution {
  readonly operationId: string
  readonly commandId: string
  readonly source?: CommandContext['source']
  readonly stage: 'started' | 'completed' | 'failed'
  readonly viewId?: string
  readonly paneId?: string
  readonly durationMs?: number
}
export type CommandResult = { readonly status: 'unavailable' }
  | { readonly status: 'completed', readonly result: unknown }

export class CommandService {
  readonly #changes: Emitter<CommandExecution>
  readonly onDidExecute
  #stopping = false
  #active = 0
  #idle = new Set<() => void>()
  #disposal: Promise<void> | undefined

  constructor(
    readonly registry: ContributionRegistry,
    readonly context: (input: CommandInvocation) => CommandContext | null,
    onListenerError: ListenerErrorHandler = () => console.error('COMMAND_OBSERVER_FAILED'),
  ) {
    this.#changes = new Emitter(onListenerError)
    this.onDidExecute = this.#changes.event
  }

  async execute(id: string, input: CommandInvocation = {}): Promise<CommandResult> {
    const command = this.registry.commands.get(id)
    const current = this.context(input)
    if (this.#stopping || !command || !current || (input.source === 'slash' && !command.slash))
      return { status: 'unavailable' }
    const context = copyEventSnapshot(current)
    if (command.enabled && !command.enabled(context))
      return { status: 'unavailable' }
    const identity = { commandId: id, source: input.source, operationId: crypto.randomUUID(), viewId: context.view?.id, paneId: context.pane?.id }
    const startedAt = performance.now()
    this.#active++
    this.#changes.fire(Object.freeze({ ...identity, stage: 'started' }))
    try {
      const result = await command.execute(context)
      this.#changes.fire(Object.freeze({ ...identity, stage: 'completed', durationMs: performance.now() - startedAt }))
      return { status: 'completed', result }
    }
    catch (error) {
      this.#changes.fire(Object.freeze({ ...identity, stage: 'failed', durationMs: performance.now() - startedAt }))
      throw error
    }
    finally {
      this.#active--
      if (!this.#active) {
        for (const resolve of this.#idle) resolve()
        this.#idle.clear()
      }
    }
  }

  stop(): void { this.#stopping = true }

  whenIdle(): Promise<void> {
    return this.#active ? new Promise(resolve => this.#idle.add(resolve)) : Promise.resolve()
  }

  dispose(): Promise<void> {
    this.stop()
    this.#disposal ??= this.whenIdle().then(() => this.#changes.dispose())
    return this.#disposal
  }
}
