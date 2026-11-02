export const RUN_EVENT_PROJECTION_VERSION = 3
export const RUN_EVENT_COMPACTION_VERSION = 1

export interface RunEventCheckpoint {
  fileFingerprint: string
  lastSequence: number
  projectionVersion: number
}

export interface RunEventRecoveryRun {
  bootstrapPending: boolean
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

export interface RunEventRecoveryProgress {
  completed: number
  total: number
}

export interface RunEventRecoveryOptions {
  force?: boolean
  onProgress?: (progress: Readonly<RunEventRecoveryProgress>) => void
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
  return checkpoint !== null
    && checkpoint.projectionVersion === RUN_EVENT_PROJECTION_VERSION
    && Number.isSafeInteger(checkpoint.lastSequence)
    && checkpoint.lastSequence >= 0
    && checkpoint.lastSequence < Number.MAX_SAFE_INTEGER
    && checkpoint.lastSequence === run.projectedLastSequence
    && fileFingerprint !== null
    && checkpoint.fileFingerprint === fileFingerprint
}

export function canCertifyBootstrapCheckpoint(
  run: RunEventRecoveryRun,
  fileFingerprint: string | null,
): run is RunEventRecoveryRun & { checkpoint: RunEventCheckpoint } {
  return run.bootstrapPending
    && isTerminalRecoveryRun(run.status)
    && canReuseRunEventCheckpoint(run, fileFingerprint)
}

export function isTerminalRecoveryRun(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
