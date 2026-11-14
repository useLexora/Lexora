import type { AppendBuddyRunEventInput } from './BuddyRunEvent'
import { executionMailboxDraftSchema, executionMailboxMessageSchema } from '../../../shared/executions/executionApi'
import { hashExecutionMailboxMessage } from '../storage/mailboxRepository'

export function prepareEventPayload(input: AppendBuddyRunEventInput, sequence: number): unknown {
  if (input.type !== 'execution.mailbox.sent')
    return input.payload ?? null
  const draft = executionMailboxDraftSchema.parse(input.payload)
  const message = { ...draft, sourceRunId: input.runId, sourceSequence: sequence }
  return executionMailboxMessageSchema.parse({ ...message, payloadHash: hashExecutionMailboxMessage(message) })
}
