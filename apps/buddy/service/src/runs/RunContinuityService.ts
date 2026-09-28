import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { RunRepository } from '../storage/runRepository'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export type RunContinuityCommit = EventSnapshot<{
  operationId: string
  revision: number
  kind: 'bound' | 'cleared'
  conversationId: string
  branchId: string
  runIds: string[]
}>

type RunContinuityRepository = Pick<RunRepository, 'findById' | 'bindSession' | 'clearSessionBindingsWithReceipt'>

export class RunContinuityService {
  readonly #repository: RunContinuityRepository
  readonly #committed: Emitter<RunContinuityCommit>
  readonly onDidCommit: Emitter<RunContinuityCommit>['event']
  #revision = 0
  #disposed = false

  constructor(repository: RunContinuityRepository, onObserverError: (error: unknown) => void = () => {}) {
    this.#repository = repository
    this.#committed = new Emitter(onObserverError)
    this.onDidCommit = this.#committed.event
  }

  bindSession(runId: string, sessionFile: string): boolean {
    this.#requireOpen()
    const run = this.#repository.findById(runId)
    if (!run)
      return false
    if (run.piSessionFile === sessionFile)
      return true
    if (!this.#repository.bindSession(runId, sessionFile))
      return false
    this.#publish('bound', run.conversationId, run.branchId, [runId])
    return true
  }

  clearForRun(runId: string): number {
    this.#requireOpen()
    const run = this.#repository.findById(runId)
    if (!run?.piSessionFile)
      return 0
    const runIds = this.#repository.clearSessionBindingsWithReceipt(run.conversationId, run.branchId, run.piSessionFile)
    if (runIds.length)
      this.#publish('cleared', run.conversationId, run.branchId, runIds)
    return runIds.length
  }

  dispose(): void {
    this.#disposed = true
    this.#committed.dispose()
  }

  #requireOpen(): void {
    if (this.#disposed)
      throw new Error('Run continuity service is stopped')
  }

  #publish(kind: RunContinuityCommit['kind'], conversationId: string, branchId: string, runIds: string[]): void {
    this.#revision += 1
    this.#committed.fire(copyEventSnapshot({ operationId: randomUUID(), revision: this.#revision, kind, conversationId, branchId, runIds }))
  }
}
