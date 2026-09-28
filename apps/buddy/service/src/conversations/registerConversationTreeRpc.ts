import type { DatabaseSync } from 'node:sqlite'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { RunRepository } from '../storage/runRepository'
import type { RegisterConversationRpcOptions } from './registerConversationRpc'
import { conversationTreeRpc } from '../../../shared/conversation/conversationTree'
import { toPublicRunEvent } from '../../../shared/runs/publicRunEvent'
import { withMessageAttachments } from '../attachments/publicAttachment'
import { BuddyServiceError, registerRuntimeRequest } from '../rpc/runtimeRequest'
import { toPublicRun } from '../runs/publicRun'
import { createConversationTreeReader } from '../storage/conversationTreeRepository'
import { projectConversationTree } from './projectConversationTree'
import { projectRunOutputs } from './projectRunOutputs'

export function registerConversationTreeRpc(options: Pick<RegisterConversationRpcOptions, 'artifacts' | 'attachments' | 'changes' | 'eventLog' | 'rpc' | 'runInputs'> & {
  database: DatabaseSync
  conversations: Pick<ConversationRepository, 'findById' | 'listBranches' | 'findMessageById'>
  runs: Pick<RunRepository, 'findById'>
}) {
  const repository = createConversationTreeReader(options.database)
  function requireConversation(conversationId: string) {
    const conversation = options.conversations.findById(conversationId)
    if (!conversation || conversation.deletedAt)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return conversation
  }
  const disposers = [registerRuntimeRequest(options.rpc, conversationTreeRpc.get, ({ conversationId }) => {
    const conversation = requireConversation(conversationId)
    return projectConversationTree({
      conversationId,
      activeBranchId: conversation.activeBranchId,
      branches: options.conversations.listBranches(conversationId),
      messages: repository.listMessages(conversationId),
      runs: repository.listRuns(conversationId),
      toolCounts: repository.listToolCounts(conversationId),
      usageByRun: repository.listRunUsage(conversationId),
      attachments: options.attachments.listForConversation(conversationId),
      outputs: projectRunOutputs(repository.listOutputEvents(conversationId), options.artifacts.listForConversation(conversationId)),
    })
  }), registerRuntimeRequest(options.rpc, conversationTreeRpc.detail, (input) => {
    requireConversation(input.conversationId)
    const attachments = options.attachments.listForConversation(input.conversationId)
    if (input.kind === 'question') {
      const message = options.conversations.findMessageById(input.messageId)
      if (!message || message.conversationId !== input.conversationId || message.role !== 'user')
        throw new BuddyServiceError('VALIDATION_FAILED')
      return {
        items: withMessageAttachments([{ ...message, kind: 'message' as const }], attachments),
        runs: [],
        runEvents: [],
        outputs: [],
        changeSets: [],
        nextCursor: null,
      }
    }
    const run = options.runs.findById(input.runId)
    if (!run || run.conversationId !== input.conversationId || run.purpose === 'conversation.compaction')
      throw new BuddyServiceError('VALIDATION_FAILED')
    const events = options.eventLog.listForRuns([run.id])
    return {
      items: withMessageAttachments(repository.listRunMessages(input.conversationId, run.id).map(message => ({ ...message, kind: 'message' as const })), attachments),
      runs: [toPublicRun(run, options.runInputs.findByRunId(run.id)?.reasoning ?? null)],
      runEvents: events.map(toPublicRunEvent),
      outputs: projectRunOutputs(events, options.artifacts.listForConversation(input.conversationId)),
      changeSets: options.changes.listSummariesForRuns([run.id]),
      nextCursor: null,
    }
  })]
  return () => disposers.forEach(dispose => dispose())
}
