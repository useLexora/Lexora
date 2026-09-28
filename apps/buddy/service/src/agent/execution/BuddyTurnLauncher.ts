import type { RunLifecycleService } from '../../runs/RunLifecycleService'
import type { BuddyAgentRunner } from './BuddyAgentRunner'
import type { BuddyRunExecutionPlanner } from './BuddyRunExecutionPlanner'
import type { BuddyTurnHandle } from './turnTypes'

export interface BuddyTurnLauncherOptions {
  lifecycle: Pick<RunLifecycleService, 'failBeforeStart'>
  planner: Pick<BuddyRunExecutionPlanner, 'resolve'>
  runner: Pick<BuddyAgentRunner, 'startCompaction' | 'startTurn'>
}

export class BuddyTurnLauncher {
  readonly #options: BuddyTurnLauncherOptions

  constructor(options: BuddyTurnLauncherOptions) {
    this.#options = options
  }

  async launch(runId: string, signal?: AbortSignal): Promise<BuddyTurnHandle> {
    let plan: Awaited<ReturnType<BuddyRunExecutionPlanner['resolve']>>
    try {
      signal?.throwIfAborted()
      plan = await this.#options.planner.resolve(runId)
      signal?.throwIfAborted()
    }
    catch (error) {
      const failed = await this.#options.lifecycle.failBeforeStart(runId, error)
      if (!failed)
        throw error
      return { completion: Promise.resolve(failed), runId }
    }
    try {
      return plan.kind === 'turn'
        ? this.#options.runner.startTurn(plan.input)
        : this.#options.runner.startCompaction(plan.input)
    }
    catch (error) {
      const failed = await this.#options.lifecycle.failBeforeStart(runId, error)
      if (!failed)
        throw error
      return { completion: Promise.resolve(failed), runId }
    }
  }
}
