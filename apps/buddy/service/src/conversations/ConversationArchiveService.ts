import type { DatabaseSync } from 'node:sqlite'
import type { ConversationArchivePolicy, ConversationArchiveQuery, ConversationArchiveTarget } from '../../../shared/conversation/conversationArchiveApi'
import type { ConversationArchiveRepository } from '../storage/conversationArchiveRepository'
import type { ConversationDeletionCommit } from '../storage/conversationDeletionRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { ConversationLifecycleService } from './ConversationLifecycleService'
import type { ConversationMutationGuard } from './ConversationMutationGuard'
import { Emitter } from '../../../shared/events/Emitter'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { withTransaction } from '../storage/database'

export class ConversationArchiveConflictError extends Error {
  readonly code: 'OBJECT_DELETED' | 'SOURCE_CHANGED'

  constructor(code: 'OBJECT_DELETED' | 'SOURCE_CHANGED') {
    super('Conversation archive target changed')
    this.name = 'ConversationArchiveConflictError'
    this.code = code
  }
}

interface Options {
  database: DatabaseSync
  repository: ConversationArchiveRepository
  conversations: Pick<ConversationRepository, 'findById'>
  mutations: ConversationMutationGuard
  lifecycle: ConversationLifecycleService
  onError: (error: unknown) => void
  now?: () => Date
}

export class ConversationArchiveService {
  readonly #options: Options
  readonly #changes: Emitter<string>
  readonly onDidChange: Emitter<string>['event']
  #stopping = false
  #sweeping: Promise<void> | null = null
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(options: Options) {
    this.#options = options
    this.#changes = new Emitter(options.onError)
    this.onDidChange = this.#changes.event
  }

  list(input: ConversationArchiveQuery) {
    return this.#options.repository.list(input)
  }

  getPolicy(): ConversationArchivePolicy {
    return this.#options.repository.getPolicy()
  }

  setPolicy(days: ConversationArchivePolicy['days']): ConversationArchivePolicy {
    this.#assertAvailable()
    if (![0, 3, 7, 30].includes(days))
      throw new BuddyServiceError('VALIDATION_FAILED')
    this.#options.repository.setPolicy(days)
    return this.getPolicy()
  }

  archive({ conversationId, expectedRevision }: ConversationArchiveTarget): Promise<boolean> {
    this.#requireActive(conversationId, expectedRevision)
    return this.#options.mutations.run(conversationId, async () => {
      await this.#options.lifecycle.suspendConversation(conversationId)
      const changed = withTransaction(this.#options.database, () => {
        this.#requireActive(conversationId, expectedRevision)
        return this.#options.repository.archive(conversationId, this.#now())
      })
      if (changed)
        this.#changes.fire(conversationId)
      return changed
    })
  }

  restore({ conversationId, expectedRevision }: ConversationArchiveTarget): boolean {
    this.#options.mutations.assertWritable(conversationId)
    const changed = withTransaction(this.#options.database, () => {
      this.#requireActive(conversationId, expectedRevision)
      return this.#options.repository.restore(conversationId, this.#now())
    })
    if (changed)
      this.#changes.fire(conversationId)
    return changed
  }

  deleteArchived(input: ConversationArchiveTarget): Promise<boolean> {
    return this.#delete(input, true)
  }

  deletePermanently(input: ConversationArchiveTarget): Promise<boolean> {
    return this.#delete(input, false)
  }

  async #delete({ conversationId, expectedRevision }: ConversationArchiveTarget, archivedOnly: boolean): Promise<boolean> {
    this.#options.mutations.assertWritable(conversationId)
    const committed = withTransaction(this.#options.database, () => {
      const conversation = this.#requireConversation(conversationId, expectedRevision)
      const job = this.#options.database.prepare('SELECT origin FROM conversation_deletion_jobs WHERE conversation_id = ?').get(conversationId)
      if ((archivedOnly && !conversation.archivedAt && job?.origin !== 'conversation') || (conversation.deletedAt && job?.origin !== 'conversation'))
        throw new ConversationArchiveConflictError('SOURCE_CHANGED')
      return this.#options.lifecycle.commitDelete(conversationId)
    })
    void this.#finishDeletion(committed).catch(this.#options.onError)
    return true
  }

  async deleteLegacyRemoved({ conversationId, expectedRevision }: ConversationArchiveTarget): Promise<boolean> {
    this.#options.mutations.assertWritable(conversationId)
    const committed = withTransaction(this.#options.database, () => {
      const conversation = this.#requireConversation(conversationId, expectedRevision)
      if (!conversation.deletedAt || conversation.archivedAt)
        throw new ConversationArchiveConflictError('SOURCE_CHANGED')
      return this.#options.lifecycle.commitLegacyRemoved(conversationId)
    })
    void this.#finishDeletion(committed).catch(this.#options.onError)
    return true
  }

  #finishDeletion(committed: ConversationDeletionCommit): Promise<boolean> {
    const pending = this.#options.lifecycle.finishDeletion(committed)
    return this.#options.mutations.run(committed.conversationId, () => pending)
  }

  start(): void {
    if (this.#timer || this.#stopping)
      return
    this.#timer = setInterval(() => void this.sweep().catch(this.#options.onError), 60_000)
    this.#timer.unref()
  }

  sweep(): Promise<void> {
    if (this.#stopping)
      return Promise.resolve()
    if (this.#sweeping)
      return this.#sweeping
    const pending = this.#sweep().finally(() => {
      if (this.#sweeping === pending)
        this.#sweeping = null
    })
    this.#sweeping = pending
    return pending
  }

  async dispose(): Promise<void> {
    this.#stopping = true
    if (this.#timer)
      clearInterval(this.#timer)
    this.#timer = null
    await this.#sweeping
    this.#changes.dispose()
  }

  async #sweep(): Promise<void> {
    for (const conversationId of this.#options.repository.due(this.#now())) {
      if (this.#stopping)
        break
      try {
        this.#options.mutations.assertWritable(conversationId)
        const committed = withTransaction(this.#options.database, () => {
          if (!this.#options.repository.isDue(conversationId, this.#now()))
            return null
          return this.#options.lifecycle.commitDelete(conversationId)
        })
        if (committed)
          await this.#finishDeletion(committed)
      }
      catch (error) {
        this.#options.onError(error)
      }
    }
  }

  #assertAvailable(): void {
    if (this.#stopping)
      throw new BuddyServiceError('CONVERSATION_BUSY')
  }

  #requireConversation(conversationId: string, expectedRevision: number) {
    this.#assertAvailable()
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const conversation = this.#options.conversations.findById(conversationId)
    if (!conversation)
      throw new ConversationArchiveConflictError('OBJECT_DELETED')
    if (conversation.metadataRevision !== expectedRevision)
      throw new ConversationArchiveConflictError('SOURCE_CHANGED')
    return conversation
  }

  #requireActive(conversationId: string, expectedRevision: number) {
    const conversation = this.#requireConversation(conversationId, expectedRevision)
    if (conversation.deletedAt)
      throw new ConversationArchiveConflictError('OBJECT_DELETED')
    return conversation
  }

  #now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString()
  }
}
