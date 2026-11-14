import type { DatabaseSync } from 'node:sqlite'
import type { ConversationArchiveTarget } from '../../../shared/conversation/conversationArchiveApi'
import type { ConversationCleanupDelete, ConversationCleanupPage, ConversationCleanupQuery, ConversationCleanupResult } from '../../../shared/conversation/conversationCleanupApi'
import type { ConversationArchiveService } from './ConversationArchiveService'
import type { ConversationLifecycleService } from './ConversationLifecycleService'
import { conversationCleanupDeleteSchema, conversationCleanupQuerySchema } from '../../../shared/conversation/conversationCleanupApi'
import { parse } from '../rpc/runtimeRequest'
import { ExecutionResourceQueries } from '../storage/ExecutionResourceQueries'
import { ConversationArchiveConflictError } from './ConversationArchiveService'

interface Options {
  database: DatabaseSync
  archive: ConversationArchiveService
  lifecycle: ConversationLifecycleService
  execute: (input: ConversationArchiveTarget) => Promise<boolean>
}

export class ConversationCleanupService {
  readonly #options: Options

  constructor(options: Options) {
    this.#options = options
  }

  list(input: ConversationCleanupQuery): ConversationCleanupPage {
    const { cursor, limit } = parse(conversationCleanupQuerySchema, input)
    const page = this.#options.archive.list({ cursor, limit, kind: 'removed' })
    const resources = new ExecutionResourceQueries(this.#options.database).conversations(page.items.map(item => item.id))
    return {
      items: page.items.map((item) => {
        const busy = resources.get(item.id) !== 'released'
        return {
          conversationId: item.id,
          title: item.title,
          removedAt: item.deletedAt!,
          expectedRevision: item.metadataRevision,
          estimatedBytes: null,
          canDelete: !busy && item.deletionStatus !== 'pending',
          blockedReason: busy ? 'CONVERSATION_BUSY' : item.deletionStatus === 'pending' ? 'CONVERSATION_CLEANUP_PENDING' : item.errorCode,
        }
      }),
      nextCursor: page.nextCursor,
    }
  }

  async execute(input: ConversationArchiveTarget): Promise<boolean> {
    try {
      return await this.#options.archive.deleteLegacyRemoved(input)
    }
    catch (error) {
      if (error instanceof ConversationArchiveConflictError)
        return false
      throw error
    }
  }

  async delete(input: ConversationCleanupDelete): Promise<ConversationCleanupResult> {
    const { conversationId, expectedRevision } = parse(conversationCleanupDeleteSchema, input)
    if (!await this.#options.execute({ conversationId, expectedRevision }))
      return { status: 'failed', errorCode: 'SOURCE_CHANGED' }
    await this.#options.lifecycle.settleDeletion(input.conversationId).catch(() => {})
    const job = this.#options.database.prepare('SELECT status, error_code FROM conversation_deletion_jobs WHERE conversation_id = ?').get(input.conversationId)
    if (job?.status === 'failed')
      return { status: 'failed', errorCode: String(job.error_code ?? 'CONVERSATION_CLEANUP_FAILED') }
    if (job || this.#options.database.prepare('SELECT 1 FROM conversations WHERE id = ?').get(input.conversationId))
      return { status: 'pending' }
    return { status: 'deleted' }
  }
}
