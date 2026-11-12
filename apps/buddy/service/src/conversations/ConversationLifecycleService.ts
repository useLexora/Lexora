import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { ConversationDeletionCommit, ConversationDeletionRepository } from '../storage/conversationDeletionRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import { randomUUID } from 'node:crypto'
import { readDiagnosticErrorCode } from '../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { BuddyServiceError } from '../rpc/runtimeRequest'

const conversationIdentityPattern = /^[A-Z0-9][\w-]{0,127}$/i

export interface ConversationLifecycleServiceOptions {
  conversations: Pick<ConversationRepository, 'findById' | 'isDeleted'>
  deletion: ConversationDeletionRepository
  assertWritable?: (conversationId: string) => void
  runner: { cancelAndWaitForConversation: (conversationId: string) => Promise<number> }
  cancelQueuedRuns: (conversationId: string) => Promise<void>
  sessions: { invalidateConversation: (conversationId: string) => Promise<{ pending: number, degraded: number }> }
  stopWriters?: (conversationId: string) => Promise<void>
  purge?: (conversationId: string) => Promise<void>
  onObserverError?: (error: unknown) => void
}

export type ConversationDeletionFact = EventSnapshot<ConversationDeletionCommit & { commitId: string }>
export type ConversationCleanupFact = Readonly<{
  conversationId: string
  operationId: string
  reason: 'delete' | 'recovery'
  status: 'started' | 'completed' | 'failed'
  errorCode?: string
}>

export class ConversationLifecycleService {
  readonly #options: ConversationLifecycleServiceOptions
  readonly #deleting = new Map<string, Promise<boolean>>()
  readonly #completed = new Set<string>()
  readonly #committed: Emitter<ConversationDeletionFact>
  readonly #cleanup: Emitter<ConversationCleanupFact>
  readonly onDidCommit: Emitter<ConversationDeletionFact>['event']
  readonly onDidCleanup: Emitter<ConversationCleanupFact>['event']
  #stopping = false

  constructor(options: ConversationLifecycleServiceOptions) {
    this.#options = options
    this.#committed = new Emitter(options.onObserverError ?? (() => {}))
    this.#cleanup = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidCommit = this.#committed.event
    this.onDidCleanup = this.#cleanup.event
  }

  delete(conversationId: string, reason: 'delete' | 'recovery' = 'delete'): Promise<boolean> {
    if (this.#stopping || !conversationIdentityPattern.test(conversationId))
      return Promise.reject(new ConversationLifecycleError())
    const current = this.#deleting.get(conversationId)
    if (current)
      return current
    if (this.#completed.has(conversationId) && !this.#options.deletion.has(conversationId))
      return Promise.resolve(false)
    this.#options.assertWritable?.(conversationId)
    const result = Promise.withResolvers<boolean>()
    this.#deleting.set(conversationId, result.promise)
    void this.#delete(conversationId, reason).then((deleted) => {
      this.#deleting.delete(conversationId)
      result.resolve(deleted)
    }, (error) => {
      this.#deleting.delete(conversationId)
      result.reject(error)
    })
    return result.promise
  }

  commitDelete(conversationId: string): ConversationDeletionCommit {
    if (this.#stopping || !conversationIdentityPattern.test(conversationId))
      throw new ConversationLifecycleError()
    this.#options.assertWritable?.(conversationId)
    const now = new Date().toISOString()
    const committed = this.#options.deletion.commit(conversationId, now)
    if (!committed)
      throw new ConversationLifecycleError()
    this.#options.deletion.retry(conversationId, now)
    return committed
  }

  commitLegacyRemoved(conversationId: string): ConversationDeletionCommit {
    if (this.#deleting.has(conversationId))
      throw new BuddyServiceError('CONVERSATION_BUSY')
    if (this.#stopping || !conversationIdentityPattern.test(conversationId))
      throw new ConversationLifecycleError()
    this.#options.assertWritable?.(conversationId)
    const now = new Date().toISOString()
    const committed = this.#options.deletion.commitLegacyRemoved(conversationId, now)
    if (!committed)
      throw new ConversationLifecycleError()
    this.#options.deletion.retry(conversationId, now)
    return committed
  }

  async suspendConversation(conversationId: string): Promise<void> {
    await this.#options.stopWriters?.(conversationId)
    await this.#options.runner.cancelAndWaitForConversation(conversationId)
    await this.#options.cancelQueuedRuns(conversationId)
    const cleanup = await this.#options.sessions.invalidateConversation(conversationId)
    if (cleanup.pending || cleanup.degraded)
      throw new ConversationCleanupError(cleanup.degraded ? 'CONVERSATION_CLEANUP_FAILED' : 'CONVERSATION_CLEANUP_PENDING')
    await this.#options.stopWriters?.(conversationId)
  }

  async settleDeletion(conversationId: string): Promise<void> {
    await this.#deleting.get(conversationId)
  }

  get hasPendingOperations(): boolean {
    return this.#deleting.size > 0
  }

  isCleanupPending(conversationId: string): boolean {
    return this.#deleting.has(conversationId)
  }

  finishDeletion(committed: ConversationDeletionCommit): Promise<boolean> {
    if (committed.tombstoned || committed.revokedGrantIds.length)
      this.#committed.fire(copyEventSnapshot({ ...committed, commitId: randomUUID() }))
    return this.delete(committed.conversationId)
  }

  isDeleting(conversationId: string): boolean {
    return this.#deleting.has(conversationId) || this.#options.conversations.isDeleted(conversationId)
  }

  async recover(conversationId: string): Promise<boolean> {
    if (this.#options.deletion.has(conversationId))
      return this.delete(conversationId, 'recovery')
    const committed = this.#options.deletion.recoverLegacy(conversationId, new Date().toISOString())
    if (!committed)
      return false
    if (committed.revokedGrantIds.length)
      this.#committed.fire(copyEventSnapshot({ ...committed, commitId: randomUUID() }))
    await this.suspendConversation(conversationId)
    return false
  }

  async recoverPendingDeletions(): Promise<number> {
    const pending = [...new Set([...this.#options.deletion.legacyPending(), ...this.#options.deletion.pending()])]
    for (const conversationId of pending) {
      try {
        await this.recover(conversationId)
      }
      catch (error) {
        this.#options.onObserverError?.(error)
      }
    }
    return pending.length
  }

  async dispose(): Promise<void> {
    this.#stopping = true
    await Promise.allSettled(this.#deleting.values())
    this.#committed.dispose()
    this.#cleanup.dispose()
    this.#completed.clear()
  }

  async #delete(conversationId: string, reason: ConversationCleanupFact['reason']): Promise<boolean> {
    const now = new Date().toISOString()
    const shouldPurge = this.#options.deletion.has(conversationId)
    const committed = shouldPurge
      ? this.#options.deletion.commit(conversationId, now)
      : this.#options.deletion.commitSoftDelete(conversationId, now)
    if (!committed)
      return false
    if (shouldPurge && reason === 'delete')
      this.#options.deletion.retry(conversationId, now)
    if (committed.tombstoned || committed.revokedGrantIds.length)
      this.#committed.fire(copyEventSnapshot({ ...committed, commitId: randomUUID() }))
    const operationId = randomUUID()
    this.#cleanup.fire(copyEventSnapshot({ conversationId, operationId, reason, status: 'started' }))
    try {
      await this.suspendConversation(conversationId)
      if (shouldPurge)
        await this.#options.purge?.(conversationId)
      this.#completed.add(conversationId)
      this.#cleanup.fire(copyEventSnapshot({ conversationId, operationId, reason, status: 'completed' }))
      return committed.tombstoned
    }
    catch (error) {
      if (shouldPurge)
        this.#options.deletion.failed(conversationId, readDiagnosticErrorCode(error), new Date().toISOString())
      this.#cleanup.fire(copyEventSnapshot({ conversationId, operationId, reason, status: 'failed', errorCode: readDiagnosticErrorCode(error) }))
      throw error
    }
  }
}

export class ConversationLifecycleError extends Error {
  readonly code = 'VALIDATION_FAILED'

  constructor() {
    super('Lexora Buddy conversation identity is invalid')
    this.name = 'ConversationLifecycleError'
  }
}

class ConversationCleanupError extends Error {
  readonly code: 'CONVERSATION_CLEANUP_FAILED' | 'CONVERSATION_CLEANUP_PENDING'

  constructor(code: 'CONVERSATION_CLEANUP_FAILED' | 'CONVERSATION_CLEANUP_PENDING') {
    super('Lexora Buddy conversation cleanup is incomplete')
    this.name = 'ConversationCleanupError'
    this.code = code
  }
}
