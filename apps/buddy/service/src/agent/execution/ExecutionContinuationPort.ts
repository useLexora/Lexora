import type { ExecutionMailboxMessage, ExecutionMailboxReceipt } from '../../../../shared/executions/executionApi'
import type { RunExecutionOutcome } from './RunExecutionBackend'

export { executionMailboxMessageSchema } from '../../../../shared/executions/executionApi'
export type { ExecutionMailboxMessage, ExecutionMailboxReceipt } from '../../../../shared/executions/executionApi'

export interface ExecutionMailboxSnapshot {
  readonly revision: number
  readonly shouldResume: boolean
  readonly messages: readonly ExecutionMailboxMessage[]
}

export type ExecutionClosePreparation
  = | { readonly kind: 'pending', readonly revision: number }
    | { readonly kind: 'sealed', readonly closingGeneration: number }

export interface ExecutionContinuationPort {
  readPending: () => Promise<ExecutionMailboxSnapshot>
  acceptInContext: (receipts: readonly ExecutionMailboxReceipt[]) => Promise<void>
  waitForChange: (input: { afterRevision: number, signal?: AbortSignal }) => Promise<void>
  prepareClose: (input: {
    outcome: RunExecutionOutcome
    consumedReceipts: readonly ExecutionMailboxReceipt[]
  }) => Promise<ExecutionClosePreparation>
}
