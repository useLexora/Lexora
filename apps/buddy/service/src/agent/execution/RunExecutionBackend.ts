import type { RunRecord } from '../../storage/runRecord'
import type { BuddySessionIdentity } from '../sessions/BuddySessionBlueprint'
import type { ActiveRunSession } from './ActiveRunRegistry'
import type { ExecutionContinuationPort } from './ExecutionContinuationPort'
import type { StartBuddyCompactionInput, StartBuddyTurnInput } from './turnTypes'

export type RunExecutionOutcome = (
  | { status: 'completed' }
  | { errorCode: string | null, status: 'cancelled' }
  | { errorCode: string, errorMessage?: string, status: 'failed' }
) & { closingGeneration?: number }

interface RunExecutionContext {
  identity: BuddySessionIdentity
  onSessionActivated: (session: ActiveRunSession) => void
  run: RunRecord
  signal: AbortSignal
  timestamp: () => string
}

export interface RunExecutionBackend {
  executeTurn: (input: RunExecutionContext & {
    continuation: ExecutionContinuationPort
    input: StartBuddyTurnInput
    onSessionStartupTimeout: () => void
  }) => Promise<RunExecutionOutcome>
  executeCompaction: (input: RunExecutionContext & {
    input: StartBuddyCompactionInput
  }) => Promise<RunExecutionOutcome>
  invalidateSessionContinuityAfterFailure: (input: {
    error: unknown
    identity: BuddySessionIdentity
    runId: string
  }) => Promise<void>
}
