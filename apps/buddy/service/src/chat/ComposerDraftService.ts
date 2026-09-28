import type {
  BuddyComposerDraft,
  BuddyComposerDraftDiscard,
  BuddyComposerDraftOpen,
  BuddyComposerDraftSave,
} from '../../../shared/conversation/composerDraft'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { ComposerDraftRepository } from '../storage/composerDraftRepository'
import { randomUUID } from 'node:crypto'
import { readDiagnosticErrorCode } from '../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export type ComposerDraftCommit = EventSnapshot<{
  operationId: string
  kind: 'opened' | 'saved' | 'discarded'
  draftId: string
  revision: number
  scope: BuddyComposerDraft['scope']
}>

export type ComposerDraftCleanup = Readonly<{
  operationId: string
  draftId: string
  status: 'started' | 'completed' | 'failed'
  errorCode?: string
}>

export class ComposerDraftService {
  readonly #repository: ComposerDraftRepository
  readonly #releaseResources: (draftId: string) => Promise<void>
  readonly #pending = new Map<string, Promise<unknown>>()
  readonly #committed: Emitter<ComposerDraftCommit>
  readonly #cleanup: Emitter<ComposerDraftCleanup>
  readonly onDidCommit: Emitter<ComposerDraftCommit>['event']
  readonly onDidCleanup: Emitter<ComposerDraftCleanup>['event']
  #stopping = false

  constructor(repository: ComposerDraftRepository, releaseResources: (draftId: string) => Promise<void>, onObserverError: (error: unknown) => void = () => {}) {
    this.#repository = repository
    this.#releaseResources = releaseResources
    this.#committed = new Emitter(onObserverError)
    this.#cleanup = new Emitter(onObserverError)
    this.onDidCommit = this.#committed.event
    this.onDidCleanup = this.#cleanup.event
  }

  list(): BuddyComposerDraft[] {
    return this.#repository.list()
  }

  find(draftId: string): BuddyComposerDraft | null {
    return this.#repository.findById(draftId)
  }

  get(draftId: string): BuddyComposerDraft {
    const draft = this.#repository.findById(draftId)
    if (!draft)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return draft
  }

  open(input: BuddyComposerDraftOpen): Promise<BuddyComposerDraft> {
    input = structuredClone(input)
    return this.#enqueue(input.draftId, () => {
      const existing = this.#repository.findByScope(input.scope)
      const draft = this.#repository.open({ ...input, now: new Date().toISOString() })
      if (!existing)
        this.#publish('opened', draft)
      return draft
    })
  }

  save(input: BuddyComposerDraftSave): Promise<BuddyComposerDraft> {
    input = structuredClone(input)
    return this.run(input.draftId, () => {
      const draft = this.#repository.save({ ...input, now: new Date().toISOString() })
      this.#publish('saved', draft)
      return draft
    })
  }

  discard(input: BuddyComposerDraftDiscard): Promise<boolean> {
    input = { ...input }
    return this.#enqueue(input.draftId, async () => {
      const existing = this.#repository.findById(input.draftId)
      if (!this.#repository.discard(input))
        return false
      if (existing)
        this.#publish('discarded', existing)
      const operationId = randomUUID()
      this.#cleanup.fire(copyEventSnapshot({ operationId, draftId: input.draftId, status: 'started' }))
      try {
        await this.#releaseResources(input.draftId)
        this.#cleanup.fire(copyEventSnapshot({ operationId, draftId: input.draftId, status: 'completed' }))
        return true
      }
      catch (error) {
        this.#cleanup.fire(copyEventSnapshot({ operationId, draftId: input.draftId, status: 'failed', errorCode: readDiagnosticErrorCode(error) }))
        throw error
      }
    })
  }

  run<T>(draftId: string, operation: () => T | Promise<T>): Promise<T> {
    return this.#enqueue(draftId, () => {
      this.get(draftId)
      return operation()
    })
  }

  #enqueue<T>(draftId: string, operation: () => T | Promise<T>): Promise<T> {
    if (this.#stopping)
      return Promise.reject(new BuddyServiceError('VALIDATION_FAILED'))
    const next = (this.#pending.get(draftId) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.#pending.set(draftId, next)
    const release = () => {
      if (this.#pending.get(draftId) === next)
        this.#pending.delete(draftId)
    }
    void next.then(release, release)
    return next
  }

  async dispose(): Promise<void> {
    this.#stopping = true
    await Promise.allSettled(this.#pending.values())
    this.#committed.dispose()
    this.#cleanup.dispose()
  }

  #publish(kind: ComposerDraftCommit['kind'], draft: BuddyComposerDraft): void {
    this.#committed.fire(copyEventSnapshot({ operationId: randomUUID(), kind, draftId: draft.draftId, revision: draft.revision, scope: draft.scope }))
  }
}
