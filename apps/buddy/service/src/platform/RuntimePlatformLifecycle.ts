import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'

export interface RuntimePlatformRecovery {
  pauseContinuations: () => void
  incompleteRunIds: () => readonly string[]
  cancelRun: (id: string, reason: string) => Promise<unknown>
  suspendConnectors: () => Promise<void>
  resumeConnectors: () => void
  invalidateSessions: () => Promise<unknown>
  isStopping: () => boolean
}

export class RuntimePlatformLifecycle {
  readonly #record: ApplicationDiagnosticReporter
  #failure: string | null = null
  #cleanup: Promise<void> | undefined

  constructor(record: ApplicationDiagnosticReporter) {
    this.#record = record
  }

  get available(): boolean { return this.#failure === null }

  assertAvailable(): void {
    if (this.#failure)
      throw Object.assign(new Error(this.#failure), { code: this.#failure })
  }

  suspend(recovery: RuntimePlatformRecovery, reason = 'PLATFORM_HOST_UNAVAILABLE'): Promise<void> {
    this.#failure = reason
    if (this.#cleanup)
      return this.#cleanup
    recovery.pauseContinuations()
    const affected = recovery.incompleteRunIds()
    this.#cleanup = (async () => {
      const results = await Promise.allSettled([
        ...affected.map(id => recovery.cancelRun(id, reason)),
        recovery.suspendConnectors(),
      ])
      const sessions = await Promise.allSettled([recovery.invalidateSessions()])
      const failures = [...results, ...sessions].filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length)
        throw new AggregateError(failures, 'PLATFORM_CLEANUP_INCOMPLETE')
      this.#record({ event: 'platform.execution_suspended', component: 'runtime.platform', level: 'warn', errorCode: reason, count: affected.length })
    })()
    return this.#cleanup
  }

  async resume(recovery: RuntimePlatformRecovery): Promise<void> {
    if (recovery.isStopping())
      throw new Error('RUNTIME_UNAVAILABLE')
    await this.#cleanup
    recovery.resumeConnectors()
    this.#failure = null
    this.#cleanup = undefined
    this.#record({ event: 'platform.execution_available', component: 'runtime.platform', level: 'info' })
  }
}
