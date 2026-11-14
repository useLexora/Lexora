import type { AutomationDispatcher } from '../../automations/AutomationDispatcher'
import type { AutomationScheduler } from '../../automations/AutomationScheduler'

interface RuntimeExecutionLifecycleOptions {
  scheduler: () => Pick<AutomationScheduler, 'dispose' | 'settle'> | null
  dispatcher: () => Pick<AutomationDispatcher, 'stop' | 'dispose'> | null
  disposeExecutions: () => Promise<void>
}

export class RuntimeExecutionLifecycle {
  readonly #options: RuntimeExecutionLifecycleOptions
  #stopped: Promise<void> | undefined

  constructor(options: RuntimeExecutionLifecycleOptions) {
    this.#options = options
  }

  stop(): Promise<void> {
    return this.#stopped ??= this.#stop()
  }

  async #stop(): Promise<void> {
    const scheduler = this.#options.scheduler()
    const dispatcher = this.#options.dispatcher()
    const scanning = scheduler?.dispose()
    dispatcher?.stop()
    const errors: unknown[] = []
    await scanning?.catch(error => errors.push(error))
    await this.#options.disposeExecutions().catch(error => errors.push(error))
    await this.#options.dispatcher()?.dispose().catch(error => errors.push(error))
    await this.#options.scheduler()?.settle().catch(error => errors.push(error))
    if (errors.length)
      throw new AggregateError(errors, 'Automation and execution cleanup failed')
  }
}
