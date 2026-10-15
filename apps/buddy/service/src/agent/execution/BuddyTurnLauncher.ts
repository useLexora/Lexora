import type { BuddyAgentRunner } from './BuddyAgentRunner'
import type { BuddyRunExecutionPlanner } from './BuddyRunExecutionPlanner'
import type { ExecutionCoordinator } from './ExecutionCoordinator'
import type { BuddyTurnHandle } from './turnTypes'

export interface BuddyTurnLauncherOptions {
  executions: Pick<ExecutionCoordinator, 'prepare' | 'failBeforeStart'>
  planner: Pick<BuddyRunExecutionPlanner, 'resolve'>
  runner: Pick<BuddyAgentRunner, 'startCompaction' | 'startTurn'>
  beforeRun?: (runId: string, signal: AbortSignal) => Promise<void>
}

export class BuddyTurnLauncher {
  readonly #options: BuddyTurnLauncherOptions

  constructor(options: BuddyTurnLauncherOptions) {
    this.#options = options
  }

  async launch(runId: string, signal?: AbortSignal): Promise<BuddyTurnHandle> {
    let preparation: ReturnType<ExecutionCoordinator['prepare']> | undefined
    try {
      preparation = this.#options.executions.prepare(runId, signal)
      preparation.signal.throwIfAborted()
      const plan = await this.#options.planner.resolve(runId)
      preparation.signal.throwIfAborted()
      if (plan.kind === 'turn')
        await this.#options.beforeRun?.(runId, preparation.signal)
      preparation.signal.throwIfAborted()
      return plan.kind === 'turn'
        ? this.#options.runner.startTurn(plan.input)
        : this.#options.runner.startCompaction(plan.input)
    }
    catch (error) {
      const failed = await this.#options.executions.failBeforeStart(runId, error)
      if (!failed)
        throw error
      return { completion: Promise.resolve(failed), runId }
    }
    finally {
      preparation?.release()
    }
  }
}
