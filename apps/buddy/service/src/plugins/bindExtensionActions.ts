import type { BuddyAgentRunner } from '../agent/execution/BuddyAgentRunner'
import type { TurnRequestService } from '../chat/TurnRequestService'
import type { ConversationLifecycleService } from '../conversations/ConversationLifecycleService'
import type { ConversationMetadataService } from '../conversations/ConversationMetadataService'
import type { RunRepository } from '../storage/runRepository'
import type { ExtensionActionService } from './ExtensionActionService'

export function bindExtensionActions(service: ExtensionActionService, sources: {
  turns: Pick<TurnRequestService, 'onDidCommit'>
  execution: Pick<BuddyAgentRunner, 'onDidSettle'>
  metadata: Pick<ConversationMetadataService, 'onDidCommit'>
  deletions: Pick<ConversationLifecycleService, 'onDidCommit'>
  runs: Pick<RunRepository, 'findById'>
}) {
  const subscriptions = [
    sources.turns.onDidCommit((event) => {
      const message = event.facts.find(fact => fact.kind === 'message.created')
      if (message?.kind === 'message.created' && sources.runs.findById(event.runId)?.purpose === 'chat')
        service.dispatch({ type: 'task:input:committed', data: { conversationId: event.conversationId, branchId: event.branchId, runId: event.runId, messageId: message.messageId, commitId: event.commitId } })
      else if (event.facts.some(fact => fact.kind === 'task.branch_activated'))
        service.cancel(event.conversationId)
    }),
    sources.execution.onDidSettle((event) => {
      const run = sources.runs.findById(event.runId)
      if (!event.stopping && run?.status === 'completed' && run.purpose === 'chat' && run.completedAt)
        service.dispatch({ type: 'task:turn:completed', data: { conversationId: event.conversationId, branchId: event.branchId, runId: event.runId, triggeringMessageId: run.triggeringMessageId, completedAt: run.completedAt } })
    }),
    sources.metadata.onDidCommit((event) => {
      if (event.kind === 'branch' || event.kind === 'model' || (event.kind === 'title' && event.titleSource === 'manual'))
        service.cancel(event.conversation.id)
    }),
    sources.deletions.onDidCommit(event => service.cancel(event.conversationId)),
  ]
  return { dispose: () => subscriptions.forEach(subscription => subscription.dispose()) }
}
