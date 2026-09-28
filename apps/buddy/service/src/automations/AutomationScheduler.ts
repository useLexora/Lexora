import type { Automation } from '../../../shared/automation'
import type { AutomationOccurrenceRecord } from '../storage/automationOccurrenceRecord'
import type { AutomationClock } from './AutomationScheduleEvaluator'
import type { AutomationService } from './AutomationService'
import { randomUUID } from 'node:crypto'
import { Temporal } from '../../../shared/automation/temporal'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { findNextAutomationOccurrence, systemAutomationClock } from './AutomationScheduleEvaluator'

export const AUTOMATION_POLL_INTERVAL_MS = 30_000
export const AUTOMATION_CATCH_UP_WINDOW_HOURS = 24
export const AUTOMATION_GLOBAL_CONCURRENCY = 2

const AUTOMATION_LEASE_DURATION_MINUTES = 1
const AUTOMATION_DUE_BATCH_SIZE = 100
const MAX_RECENT_CANDIDATES = 48

export interface AutomationSchedulerOptions {
  automationService: AutomationService
  clock?: AutomationClock
  createOwnerId?: () => string
  dispatch: (occurrence: AutomationOccurrenceRecord) => Promise<void>
  onObserverError?: (error: unknown) => void
}

export class AutomationScheduler {
  readonly #automationService: AutomationService
  readonly #clock: AutomationClock
  readonly #dispatch: AutomationSchedulerOptions['dispatch']
  readonly #changes: Emitter<Readonly<{ state: 'starting' | 'ready' | 'degraded' | 'stopping' | 'drained', activeCount: number, errorCode?: string }>>
  readonly onDidChange: Emitter<Readonly<{ state: 'starting' | 'ready' | 'degraded' | 'stopping' | 'drained', activeCount: number, errorCode?: string }>>['event']
  readonly #owner: string
  readonly #activeDispatches = new Map<string, Promise<void>>()
  #disposed = false
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #scan: Promise<void> | null = null
  #started = false
  #state: 'starting' | 'ready' | 'degraded' | 'stopping' | 'drained' = 'starting'
  #starting: Promise<void> | null = null
  #scanRequested = false
  readonly #dispatchFailures = new Map<string, { automationId: string, error: unknown }>()

  constructor(options: AutomationSchedulerOptions) {
    this.#automationService = options.automationService
    this.#clock = options.clock ?? systemAutomationClock
    this.#dispatch = options.dispatch
    this.#changes = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidChange = this.#changes.event
    this.#owner = (options.createOwnerId ?? randomUUID)()
  }

  get state() { return this.#state }

  async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true
      this.#publish('stopping')
    }
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    await this.#scan?.catch(() => {})
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.#activeDispatches.values()])
    this.#reconcileDispatchFailures()
    if (this.#dispatchFailures.size) {
      this.#publish('degraded', 'AUTOMATION_DISPATCH_FAILED')
      throw new AggregateError([...this.#dispatchFailures.values()].map(item => item.error), 'Automation dispatch cleanup failed')
    }
    if (this.#disposed) {
      this.#publish('drained')
      this.#changes.dispose()
    }
  }

  start(): Promise<void> {
    if (this.#disposed)
      return Promise.reject(new Error('Automation scheduler is stopped'))
    if (this.#started)
      return Promise.resolve()
    if (this.#starting)
      return this.#starting
    this.#publish('starting')
    const starting = this.#requestScan().then(() => {
      if (this.#disposed)
        return
      this.#started = true
      this.#pollTimer = setInterval(() => {
        void this.wake().catch(() => {})
      }, AUTOMATION_POLL_INTERVAL_MS)
    }).finally(() => {
      if (this.#starting === starting)
        this.#starting = null
    })
    this.#starting = starting
    return starting
  }

  wake(): Promise<void> {
    if (this.#disposed)
      return Promise.resolve()
    return this.#requestScan()
  }

  #requestScan(): Promise<void> {
    this.#scanRequested = true
    if (this.#scan)
      return this.#scan
    const scan = Promise.resolve().then(async () => {
      while (this.#scanRequested && !this.#disposed) {
        this.#scanRequested = false
        await this.#runScan()
      }
      if (!this.#disposed)
        this.#publish(this.#dispatchFailures.size ? 'degraded' : 'ready')
    }).catch((error) => {
      this.#publish('degraded', 'AUTOMATION_SCAN_FAILED')
      throw error
    }).finally(() => {
      if (this.#scan === scan)
        this.#scan = null
    })
    this.#scan = scan
    return scan
  }

  #publish(state: 'starting' | 'ready' | 'degraded' | 'stopping' | 'drained', errorCode?: string): void {
    this.#state = state
    this.#changes.fire(copyEventSnapshot({ state, activeCount: this.#activeDispatches.size, ...(errorCode ? { errorCode } : {}) }))
  }

  async #runScan(): Promise<void> {
    if (this.#disposed)
      return
    this.#reconcileDispatchFailures()
    const now = this.#clock.now()
    const nowText = formatInstant(now)
    for (let batch = 0; batch < 100 && !this.#disposed; batch += 1) {
      const due = this.#automationService.listDue(nowText, AUTOMATION_DUE_BATCH_SIZE)
      if (due.length === 0)
        break
      for (const automation of due) {
        if (this.#disposed)
          break
        this.#processDueAutomation(automation, now)
      }
      if (due.length < AUTOMATION_DUE_BATCH_SIZE)
        break
    }
    if (!this.#disposed)
      this.#dispatchAvailable()
  }

  #processDueAutomation(
    automation: Automation,
    now: Temporal.Instant,
  ): void {
    if (!automation.nextRunAt)
      return
    const earliest = Temporal.Instant.from(automation.nextRunAt)
    const isOnce = automation.timing.schedule.kind === 'once'
    const cutoff = now.subtract({ hours: AUTOMATION_CATCH_UP_WINDOW_HOURS })
    if (Temporal.Instant.compare(earliest, cutoff) < 0) {
      this.#settleMissed(
        automation,
        now,
        isOnce ? 'expired' : 'skipped',
        'MISSED_WINDOW_EXCEEDED',
      )
      return
    }

    const candidates = collectDueCandidates(automation, now)
    const latest = candidates.at(-1)
    if (!latest)
      return
    const common = {
      advanceAfter: formatInstant(now),
      automationId: automation.id,
      coalescedMissedCount: candidates.length - 1,
      expectedNextRunAt: automation.nextRunAt,
      expectedRevision: automation.revision,
      scheduledFor: formatInstant(latest),
    }
    this.#automationService.claimScheduled(common)
  }

  #settleMissed(
    automation: Automation,
    now: Temporal.Instant,
    status: 'expired' | 'skipped',
    errorCode: 'MISSED_WINDOW_EXCEEDED',
  ): void {
    if (!automation.nextRunAt)
      return
    this.#automationService.settleScheduled({
      advanceAfter: formatInstant(now),
      automationId: automation.id,
      coalescedMissedCount: 0,
      errorCode,
      expectedNextRunAt: automation.nextRunAt,
      expectedRevision: automation.revision,
      scheduledFor: automation.nextRunAt,
      status,
    })
  }

  #reconcileDispatchFailures(): void {
    for (const [id, failure] of this.#dispatchFailures) {
      const occurrence = this.#automationService.getOccurrence(id)
      if (!occurrence || this.#automationService.getActiveOccurrence(failure.automationId)?.id !== id)
        this.#dispatchFailures.delete(id)
    }
  }

  #dispatchAvailable(): void {
    if (this.#disposed)
      return
    const available = AUTOMATION_GLOBAL_CONCURRENCY - this.#activeDispatches.size
    if (available <= 0)
      return
    const now = this.#clock.now()
    const leased = this.#automationService.leaseQueued({
      leaseExpiresAt: formatInstant(now.add({ minutes: AUTOMATION_LEASE_DURATION_MINUTES })),
      limit: available,
      now: formatInstant(now),
      owner: this.#owner,
    })
    for (const occurrence of leased) {
      const dispatch = Promise.resolve()
        .then(() => this.#disposed ? undefined : this.#dispatch(occurrence))
        .catch((error) => {
          if (this.#disposed && error instanceof Error && error.name === 'AbortError')
            return
          this.#publish('degraded', 'AUTOMATION_DISPATCH_FAILED')
          try {
            const finished = this.#automationService.finishQueued({
              errorCode: 'RUNTIME_RESTARTED',
              id: occurrence.id,
              leaseOwner: this.#owner,
              status: 'skipped',
            })
            if (!finished && this.#automationService.getActiveOccurrence(occurrence.automationId)?.id === occurrence.id)
              this.#dispatchFailures.set(occurrence.id, { automationId: occurrence.automationId, error })
          }
          catch (cleanup) {
            this.#dispatchFailures.set(occurrence.id, { automationId: occurrence.automationId, error: cleanup })
          }
        })
        .then(() => {})
        .finally(() => {
          this.#activeDispatches.delete(occurrence.id)
          if (!this.#disposed) {
            try {
              this.#dispatchAvailable()
            }
            catch {
              this.#publish('degraded', 'AUTOMATION_SCAN_FAILED')
            }
          }
        })
      this.#activeDispatches.set(occurrence.id, dispatch)
    }
  }
}

function collectDueCandidates(
  automation: Automation,
  now: Temporal.Instant,
): Temporal.Instant[] {
  if (!automation.nextRunAt)
    return []
  const candidates: Temporal.Instant[] = []
  let candidate: Temporal.Instant | null = Temporal.Instant.from(automation.nextRunAt)
  while (
    candidate
    && Temporal.Instant.compare(candidate, now) <= 0
    && candidates.length < MAX_RECENT_CANDIDATES
  ) {
    candidates.push(candidate)
    candidate = findNextAutomationOccurrence(automation.timing, candidate)
  }
  return candidates
}

function formatInstant(value: Temporal.Instant): string {
  return value.toString({ smallestUnit: 'millisecond' })
}
