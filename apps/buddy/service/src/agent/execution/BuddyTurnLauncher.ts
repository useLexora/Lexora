import type { BuddyAgentRunner } from './BuddyAgentRunner'
import type { BuddyRunExecutionPlanner } from './BuddyRunExecutionPlanner'
import type { ExecutionCoordinator } from './ExecutionCoordinator'
import type { BuddyTurnHandle } from './turnTypes'

export interface BuddyTurnLauncherOptions {
  executions: Pick<ExecutionCoordinator, 'prepare' | 'failBeforeStart'> & Partial<Pick<ExecutionCoordinator, 'assertPrepared'>>
  planner: Pick<BuddyRunExecutionPlanner, 'resolve'>
  runner: Pick<BuddyAgentRunner, 'startCompaction' | 'startTurn'>
  assertStorageAvailable?: () => void
  assertServiceAccepting?: () => void
  beforeRun?: (runId: string, signal: AbortSignal) => Promise<void>
}

export class BuddyTurnLauncher {
  readonly #options: BuddyTurnLauncherOptions

  constructor(options: BuddyTurnLauncherOptions) {
    this.#options = options
  }

  async launch(runId: string, signal?: AbortSignal): Promise<BuddyTurnHandle> {
    this.#options.assertStorageAvailable?.()
    let preparation: ReturnType<ExecutionCoordinator['prepare']> | undefined
    try {
      this.#options.assertServiceAccepting?.()
      preparation = this.#options.executions.prepare(runId, signal)
      preparation.signal.throwIfAborted()
      const plan = await this.#options.planner.resolve(runId)
      this.#options.assertStorageAvailable?.()
      preparation.signal.throwIfAborted()
      this.#options.assertServiceAccepting?.()
      this.#options.executions.assertPrepared?.(runId)
      if (plan.kind === 'turn')
        await this.#options.beforeRun?.(runId, preparation.signal)
      preparation.signal.throwIfAborted()
      this.#options.assertStorageAvailable?.()
      this.#options.assertServiceAccepting?.()
      this.#options.executions.assertPrepared?.(runId)
      return plan.kind === 'turn'
        ? this.#options.runner.startTurn(plan.input)
        : this.#options.runner.startCompaction(plan.input)
    }
    catch (error) {
      this.#options.assertStorageAvailable?.()
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
