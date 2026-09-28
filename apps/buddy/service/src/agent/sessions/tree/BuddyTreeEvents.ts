import type { EventSnapshot } from '../../../../../shared/events/eventTypes'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../../shared/events/eventSnapshot'

export type TreeRecoverySource = 'native_endpoint' | 'legacy' | 'product_history'

export type BuddyTreeFact = {
  operationId: string
  conversationId: string
  treeId: string
} & (
  | { kind: 'file.created' }
  | { kind: 'binding.committed', reason: 'created' | 'replaced' | 'reconciled' }
  | { kind: 'entries.imported', runId: string, branchId: string, entryCount: number }
  | { kind: 'checkpoint.committed', runId: string, branchId: string, checkpointId: string, position: 'before' | 'after', recovery?: { source: TreeRecoverySource, missingAttachmentCount?: number, recoveredImageCount?: number } }
)

export type BuddyTreeCommit = EventSnapshot<BuddyTreeFact & { revision: number }>
export type BuddyTreeFailure = EventSnapshot<{
  operationId: string
  conversationId: string
  stage: 'open' | 'binding' | 'checkpoint' | 'import' | 'import_index'
  errorCode: 'SESSION_STORAGE_UNAVAILABLE' | 'CONVERSATION_BINDING_MISMATCH'
}>

export class BuddyTreeEvents {
  readonly #committed: Emitter<BuddyTreeCommit>
  readonly #failed: Emitter<BuddyTreeFailure>
  #revision = 0
  #disposed = false
  readonly onDidCommit: Emitter<BuddyTreeCommit>['event']
  readonly onDidFail: Emitter<BuddyTreeFailure>['event']

  constructor(onObserverError: (error: unknown) => void = () => {}) {
    this.#committed = new Emitter(onObserverError)
    this.#failed = new Emitter(onObserverError)
    this.onDidCommit = this.#committed.event
    this.onDidFail = this.#failed.event
  }

  assertOpen() {
    if (this.#disposed)
      throw new Error('Conversation tree is stopped')
  }

  commit(fact: BuddyTreeFact) {
    this.#committed.fire(copyEventSnapshot({ ...fact, revision: ++this.#revision }))
  }

  fail(conversationId: string, stage: BuddyTreeFailure['stage'], error: unknown, operationId = randomUUID()) {
    this.#failed.fire(copyEventSnapshot({
      operationId,
      conversationId,
      stage,
      errorCode: error && typeof error === 'object' && 'code' in error && error.code === 'CONVERSATION_BINDING_MISMATCH'
        ? 'CONVERSATION_BINDING_MISMATCH'
        : 'SESSION_STORAGE_UNAVAILABLE',
    }))
  }

  dispose() {
    this.#disposed = true
    this.#committed.dispose()
    this.#failed.dispose()
  }
}
