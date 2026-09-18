import type {
  BuddyComposerDraft,
  BuddyComposerDraftDiscard,
  BuddyComposerDraftOpen,
  BuddyComposerDraftSave,
} from '../../../shared/conversation/composerDraft'
import type { ComposerDraftRepository } from '../storage/composerDraftRepository'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export class ComposerDraftService {
  readonly #repository: ComposerDraftRepository
  readonly #releaseResources: (draftId: string) => Promise<void>
  readonly #pending = new Map<string, Promise<unknown>>()

  constructor(repository: ComposerDraftRepository, releaseResources: (draftId: string) => Promise<void>) {
    this.#repository = repository
    this.#releaseResources = releaseResources
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
    return this.#enqueue(input.draftId, () => this.#repository.open({ ...input, now: new Date().toISOString() }))
  }

  save(input: BuddyComposerDraftSave): Promise<BuddyComposerDraft> {
    return this.run(input.draftId, () => this.#repository.save({ ...input, now: new Date().toISOString() }))
  }

  discard(input: BuddyComposerDraftDiscard): Promise<boolean> {
    return this.#enqueue(input.draftId, async () => {
      if (!this.#repository.discard(input))
        return false
      await this.#releaseResources(input.draftId)
      return true
    })
  }

  run<T>(draftId: string, operation: () => T | Promise<T>): Promise<T> {
    return this.#enqueue(draftId, () => {
      this.get(draftId)
      return operation()
    })
  }

  #enqueue<T>(draftId: string, operation: () => T | Promise<T>): Promise<T> {
    const next = (this.#pending.get(draftId) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.#pending.set(draftId, next)
    const release = () => {
      if (this.#pending.get(draftId) === next)
        this.#pending.delete(draftId)
    }
    void next.then(release, release)
    return next
  }
}
