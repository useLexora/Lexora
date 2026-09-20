import type { DatabaseSync } from 'node:sqlite'
import type { LocalChatQueueItem, LocalChatQueueReceipt, LocalChatQueueScope, LocalChatQueueTarget } from '../../../shared/conversation/chatQueueApi'
import type { PrepareTurnRequestInput } from './turnRequestRepository'
import { buddyUserMessageContentV1Schema } from '../../../shared/conversation/buddyUserContent'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { createAttachmentRepository } from './attachmentRepository'
import { createComposerDraftCommitter } from './commitComposerDraft'
import { withTransaction } from './database'
import { assertTurnAttachmentBindings, resolveTurnExecutionProfile, TurnRequestAttachmentError } from './turnRequestRepository'

interface QueueRow {
  id: string
  conversation_id: string
  branch_id: string
  prepared_json: string
  state: 'waiting' | 'paused' | 'sent' | 'cancelled'
  request_fingerprint: string
  created_at: string
}

export type ChatQueueRepository = ReturnType<typeof createChatQueueRepository>

export function createChatQueueRepository(database: DatabaseSync) {
  const attachments = createAttachmentRepository(database)
  const commitDraft = createComposerDraftCommitter(database)
  const find = (id: string) => database.prepare('SELECT * FROM chat_queue WHERE id = ?').get(id) as QueueRow | undefined
  const decode = (row: QueueRow) => JSON.parse(row.prepared_json) as PrepareTurnRequestInput
  const receipt = (row: QueueRow): LocalChatQueueReceipt => {
    const input = decode(row)
    return { id: row.id, conversationId: row.conversation_id, branchId: row.branch_id, draftReceipt: { draftId: input.draft.draftId, sourceRevision: input.draft.expectedRevision, committedRevision: input.draft.expectedRevision + 1 } }
  }
  const assertScope = (scope: LocalChatQueueScope) => {
    if (!database.prepare('SELECT id FROM conversations WHERE id = ? AND active_branch_id = ? AND deleted_at IS NULL').get(scope.conversationId, scope.branchId))
      throw new BuddyServiceError('VALIDATION_FAILED')
  }
  return {
    replay(requestId: string, fingerprint: string) {
      const row = database.prepare('SELECT * FROM chat_queue WHERE request_id = ?').get(requestId) as QueueRow | undefined
      if (!row)
        return null
      if (row.request_fingerprint !== fingerprint)
        throw new BuddyServiceError('VALIDATION_FAILED')
      return receipt(row)
    },
    enqueue(input: PrepareTurnRequestInput) {
      return withTransaction(database, () => {
        assertScope(input)
        assertTurnAttachmentBindings(input)
        const id = input.userMessageId
        if (input.followup)
          throw new BuddyServiceError('VALIDATION_FAILED')
        for (const binding of input.attachmentBindings) {
          const source = attachments.findById(binding.sourceAttachmentId)
          if (!source || (binding.sourceDraftId ? source.draftId !== input.draft.draftId : source.conversationId !== input.conversationId))
            throw new TurnRequestAttachmentError()
          if (binding.sourceDraftId) {
            database.prepare('UPDATE attachments SET draft_id = ?, stored_path = ? WHERE id = ?').run(id, binding.storedPath, source.id)
          }
          else {
            attachments.create({ ...source, id: binding.id, draftId: id, messageId: null, conversationId: null, storedPath: binding.storedPath })
          }
        }
        const prepared: PrepareTurnRequestInput = {
          ...input,
          queuedMessageId: id,
          attachmentBindings: input.attachmentBindings.map(binding => ({ ...binding, sourceDraftId: id, sourceAttachmentId: binding.id })),
        }
        commitDraft({ ...input, draftId: input.draft.draftId, expectedRevision: input.draft.expectedRevision, updatedAt: input.createdAt })
        database.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)`).run(id, input.conversationId, input.branchId, input.requestId, input.requestFingerprint, JSON.stringify(prepared), input.createdAt)
        return receipt(find(id)!)
      })
    },
    list(scope: LocalChatQueueScope): LocalChatQueueItem[] {
      if (!database.prepare('SELECT id FROM conversations WHERE id = ? AND deleted_at IS NULL').get(scope.conversationId))
        return []
      return (database.prepare('SELECT * FROM chat_queue WHERE conversation_id = ? AND branch_id = ? AND state IN (\'waiting\', \'paused\') ORDER BY rowid').all(scope.conversationId, scope.branchId) as unknown as QueueRow[]).map((row) => {
        const input = decode(row)
        return { id: row.id, conversationId: row.conversation_id, branchId: row.branch_id, state: row.state as 'waiting' | 'paused', content: buddyUserMessageContentV1Schema.parse(input.userMessageContent), createdAt: row.created_at, attachments: input.runInput.attachmentIds.map((id) => {
          const attachment = attachments.findById(id)
          if (!attachment)
            throw new TurnRequestAttachmentError()
          return { id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }
        }) }
      })
    },
    pending(target: LocalChatQueueTarget) {
      assertScope(target)
      const row = find(target.id)
      return row && row.conversation_id === target.conversationId && row.branch_id === target.branchId && ['waiting', 'paused'].includes(row.state) ? decode(row) : null
    },
    cancel(target: LocalChatQueueTarget) {
      const row = find(target.id)
      if (!row || row.conversation_id !== target.conversationId || row.branch_id !== target.branchId)
        return false
      return Number(database.prepare('UPDATE chat_queue SET state = \'cancelled\' WHERE id = ? AND state IN (\'waiting\', \'paused\')').run(target.id).changes) === 1
    },
    activeRun(scope: LocalChatQueueScope) {
      return database.prepare('SELECT id, purpose, model, provider FROM runs WHERE conversation_id = ? AND status IN (\'queued\', \'running\') ORDER BY started_at DESC LIMIT 1').get(scope.conversationId) as { id: string, purpose: string, model: string, provider: string } | undefined
    },
    pause(conversationId?: string) {
      if (conversationId)
        database.prepare('UPDATE chat_queue SET state = \'paused\' WHERE conversation_id = ? AND state = \'waiting\'').run(conversationId)
      else
        database.prepare('UPDATE chat_queue SET state = \'paused\' WHERE state = \'waiting\'').run()
    },
    commitInRun(input: PrepareTurnRequestInput, runId: string) {
      return withTransaction(database, () => {
        assertScope(input)
        if (!database.prepare('SELECT id FROM chat_queue WHERE id = ? AND state IN (\'waiting\', \'paused\')').get(input.queuedMessageId!))
          throw new BuddyServiceError('VALIDATION_FAILED')
        const run = database.prepare('SELECT id FROM runs WHERE id = ? AND conversation_id = ? AND branch_id = ? AND status = \'running\' AND purpose = \'chat\' AND approval_policy = ? AND execution_profile = ?').get(runId, input.conversationId, input.branchId, input.approvalPolicy, resolveTurnExecutionProfile(input))
        if (!run)
          throw new BuddyServiceError('VALIDATION_FAILED')
        database.prepare('INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at) VALUES (?, ?, ?, NULL, \'user\', ?, ?)').run(input.userMessageId, input.conversationId, input.branchId, JSON.stringify(input.userMessageContent), new Date().toISOString())
        for (const binding of input.attachmentBindings) {
          if (Number(database.prepare('UPDATE attachments SET draft_id = NULL, message_id = ? WHERE id = ? AND draft_id = ?').run(input.userMessageId, binding.id, input.queuedMessageId!).changes) !== 1)
            throw new TurnRequestAttachmentError()
        }
        database.prepare('UPDATE chat_queue SET state = \'sent\', run_id = ? WHERE id = ?').run(runId, input.queuedMessageId!)
      })
    },
  }
}
