// Bump when projection semantics or the compaction plan become incompatible.
export const RUN_EVENT_PROJECTION_VERSION = 3

export interface RunEventCheckpoint {
  fileFingerprint: string
  lastSequence: number
  projectionVersion: number
}

export interface RunEventRecoveryRun {
  checkpoint: RunEventCheckpoint | null
  conversationId: string
  projectedLastSequence: number
  runId: string
  status: string
}

export interface RunEventRecoveryFailure {
  code: 'EVENT_LOG_CORRUPTED'
  conversationId: string | null
  runId: string
}

export interface RunEventRecoverySummary {
  durationMs: number
  enumerationMs: number
  inspectionMs: number
  readMs: number
  projectionMs: number
  scanned: number
  skipped: number
  rebuilt: number
  events: number
  failed: number
  failures: readonly Readonly<RunEventRecoveryFailure>[]
}

export function canReuseRunEventCheckpoint(
  run: RunEventRecoveryRun,
  fileFingerprint: string | null,
): run is RunEventRecoveryRun & { checkpoint: RunEventCheckpoint } {
  const checkpoint = run.checkpoint
  return isTerminalRecoveryRun(run.status)
    && checkpoint !== null
    && checkpoint.projectionVersion === RUN_EVENT_PROJECTION_VERSION
    && Number.isSafeInteger(checkpoint.lastSequence)
    && checkpoint.lastSequence >= 0
    && checkpoint.lastSequence < Number.MAX_SAFE_INTEGER
    && checkpoint.lastSequence === run.projectedLastSequence
    && fileFingerprint !== null
    && checkpoint.fileFingerprint === fileFingerprint
}

export function isTerminalRecoveryRun(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
