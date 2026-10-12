import type { RunRecord } from '../../storage/runRecord'
import type { ExecutionContinuationPort } from './ExecutionContinuationPort'
import type { RunExecutionOutcome } from './RunExecutionBackend'

export interface ExecutionLifecyclePort {
  begin: (runId: string, signal: AbortSignal) => Promise<ExecutionContinuationPort>
  finalize: (input: {
    runId: string
    outcome: RunExecutionOutcome
    cleanup: 'completed' | 'degraded'
  }) => Promise<RunRecord>
  cancel: (runId: string, errorCode: string, stop: (runId: string) => Promise<boolean>) => Promise<boolean>
  cancelAll: (filter: { conversationId?: string, runIds?: readonly string[] }, stop: (runId: string) => Promise<boolean>) => Promise<number>
}
