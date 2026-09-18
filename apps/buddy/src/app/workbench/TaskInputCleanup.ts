import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyComposerDraftDiscard } from '@buddy-shared/conversation/composerDraft'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { buddyComposerDraftDiscardSchema } from '@buddy-shared/conversation/composerDraft'

export class TaskInputCleanup {
  #tail: Promise<void> = Promise.resolve()

  constructor(
    readonly controller: WorkbenchController,
    readonly persistence: WorkbenchPersistence,
    readonly api: Pick<LocalChatApi['composerDrafts'], 'discard' | 'list'>,
    readonly hasContext: (draftId: string) => boolean,
  ) {}

  pending(): BuddyComposerDraftDiscard[] {
    const values = this.controller.layout.auxiliary.pendingInputDiscards
    return Array.isArray(values)
      ? values.flatMap((value) => {
          const parsed = buddyComposerDraftDiscardSchema.safeParse(value)
          return parsed.success ? [parsed.data] : []
        })
      : []
  }

  add(input: BuddyComposerDraftDiscard): void {
    this.controller.layout.auxiliary.pendingInputDiscards = [...this.pending().filter(item => item.draftId !== input.draftId), { ...input }]
  }

  restore(hasLayout: boolean): Promise<void> {
    return this.#enqueue(async () => {
      await this.#flush()
      if (!hasLayout)
        return
      for (const draft of await this.api.list()) {
        if (draft.scope.kind === 'task' && !this.#isOpen(draft.draftId) && !this.hasContext(draft.draftId))
          this.add({ draftId: draft.draftId, expectedRevision: draft.revision })
      }
      if (this.pending().length)
        this.controller.changed()
      await this.#flush()
    })
  }

  flush(): Promise<void> {
    return this.#enqueue(() => this.#flush())
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    this.#tail = this.#tail.catch(() => {}).then(operation)
    return this.#tail
  }

  #isOpen(id: string): boolean {
    return Object.values(this.controller.layout.views).some(view => view.resource.scheme === 'draft' && view.resource.id === id)
  }

  async #flush(): Promise<void> {
    await this.persistence.flush()
    try {
      for (const input of this.pending()) {
        if (this.#isOpen(input.draftId) || this.hasContext(input.draftId))
          continue
        await this.api.discard(input)
        this.controller.layout.auxiliary.pendingInputDiscards = this.pending().filter(item => item.draftId !== input.draftId)
        this.controller.changed()
      }
    }
    finally {
      await this.persistence.flush()
    }
  }
}
