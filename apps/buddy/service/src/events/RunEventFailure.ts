import type { BuddyRunEvent } from './BuddyRunEvent'

export interface RunEventFailureScope {
  firstSequence: number | null
  lastSequence: number | null
  runId: string
}

export abstract class RunEventLogUnavailableError extends Error {
  abstract readonly code: string
  abstract readonly commitState: 'committed' | 'not_applicable' | 'unknown'
  readonly firstSequence: number | null
  readonly lastSequence: number | null
  readonly runId: string

  constructor(message: string, scope: RunEventFailureScope, options?: ErrorOptions) {
    super(message, options)
    this.firstSequence = scope.firstSequence
    this.lastSequence = scope.lastSequence
    this.runId = scope.runId
  }
}

export abstract class RunEventLogFatalError extends RunEventLogUnavailableError {}

export class RunEventCorruptionError extends RunEventLogUnavailableError {
  readonly code = 'EVENT_LOG_CORRUPTED'
  readonly commitState = 'not_applicable'

  constructor(runId: string, options?: ErrorOptions) {
    super(
      'Lexora Buddy run event log is corrupted',
      runEventFailureScope(runId),
      options,
    )
    this.name = 'RunEventCorruptionError'
  }
}

export class RunEventCheckpointError extends RunEventLogFatalError {
  readonly code = 'EVENT_PROJECTION_FAILED'
  readonly commitState = 'not_applicable'

  constructor(runId: string, options?: ErrorOptions) {
    super('Lexora Buddy run event checkpoint invalidation failed', runEventFailureScope(runId), options)
    this.name = 'RunEventCheckpointError'
  }
}

export class RunEventProjectionError extends RunEventLogFatalError {
  readonly code = 'EVENT_PROJECTION_FAILED'
  readonly commitState = 'committed'
  readonly committed = true

  constructor(
    runId: string,
    events: readonly BuddyRunEvent[],
    options?: ErrorOptions,
  ) {
    super(
      'Lexora Buddy durable run event projection failed',
      runEventFailureScope(runId, events),
      options,
    )
    this.name = 'RunEventProjectionError'
  }
}

export class RunEventStorageError extends RunEventLogFatalError {
  readonly code = 'EVENT_STORAGE_FAILED'
  readonly commitState: 'committed' | 'not_applicable' | 'unknown'
  readonly operation: 'append' | 'compact' | 'read' | 'repair' | 'scan'
  readonly stage: 'close' | 'directory' | 'mkdir' | 'open' | 'read' | 'readdir' | 'rename' | 'stat' | 'sync' | 'truncate' | 'unlink' | 'write'

  constructor(
    scope: RunEventFailureScope,
    operation: RunEventStorageError['operation'],
    stage: RunEventStorageError['stage'],
    commitState: RunEventStorageError['commitState'],
    options?: ErrorOptions,
  ) {
    super('Lexora Buddy run event storage failed', scope, options)
    this.name = 'RunEventStorageError'
    this.commitState = commitState
    this.operation = operation
    this.stage = stage
  }
}

export function runEventFailureScope(
  runId: string,
  events: readonly BuddyRunEvent[] = [],
): RunEventFailureScope {
  return {
    firstSequence: events[0]?.sequence ?? null,
    lastSequence: events.at(-1)?.sequence ?? null,
    runId,
  }
}
