import type { ProductRecoveryItem } from '../../../shared/runtime/productRecovery'
import type { DesktopNotificationInbox } from '../notifications/DesktopNotificationInbox'
import { buddyUserContentToText } from '../../../shared/conversation/buddyUserContent'
import { recoveryNotificationPrefix } from '../../shared/desktopNotifications'

export class ProductRecoveryNotifications {
  readonly #inbox: DesktopNotificationInbox
  readonly #items: () => Promise<ProductRecoveryItem[]>
  readonly #onError: (error: unknown) => void
  readonly #published = new Set<string>()
  #version = 0
  #refreshing: Promise<void> | undefined
  #recheck: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(inbox: DesktopNotificationInbox, items: () => Promise<ProductRecoveryItem[]>, onError: (error: unknown) => void) {
    this.#inbox = inbox
    this.#items = items
    this.#onError = onError
  }

  #publish(item: ProductRecoveryItem) {
    const { id, state, sourceKind, sourceTitle } = item
    const unsaved = item.method === 'composerDrafts.save' && (state === 'rejected' || state === 'not_accepted')
    const preview = unsaved && item.content ? [...buddyUserContentToText(item.content).replace(/\s+/gu, ' ').trim()].slice(0, 100).join('') : undefined
    this.#published.add(id)
    this.#inbox.publish({
      id: recoveryNotificationPrefix + id,
      kind: 'operation.recovery',
      revision: state,
      occurredAt: item.createdAt,
      origin: 'desktop',
      lifecycle: 'active',
      action: { type: 'review-operation', recoveryId: id },
      presentation: { title: unsaved ? 'desktop.recovery.unsavedInput' : 'desktop.recovery.title', sourceKind, sourceTitle, preview, description: `desktop.recovery.${state}`, icon: 'messageRetry' },
    })
    if (state === 'unknown' && !this.#recheck) {
      this.#recheck = setTimeout(() => {
        this.#recheck = undefined
        void this.reconcile()
      }, 15_000)
      this.#recheck.unref()
    }
  }

  replace(items: ProductRecoveryItem[]) {
    if (this.#disposed)
      return
    this.#version++
    const active = new Set(items.map(item => item.id))
    for (const id of this.#published) {
      if (!active.has(id) && this.#published.delete(id))
        this.#inbox.withdraw(recoveryNotificationPrefix + id)
    }
    for (const item of items)
      this.#publish(item)
  }

  withdraw(id: string) {
    this.#version++
    if (this.#published.delete(id))
      this.#inbox.withdraw(recoveryNotificationPrefix + id)
  }

  reset() {
    this.#version++
    for (const id of this.#published)
      this.withdraw(id)
    clearTimeout(this.#recheck)
    this.#recheck = undefined
  }

  reconcile(): Promise<void> {
    this.#version++
    return this.#refreshing ??= this.#restore()
  }

  async #restore() {
    try {
      while (!this.#disposed) {
        const version = this.#version
        const items = await this.#items().catch((error: unknown) => {
          if (this.#disposed || version !== this.#version)
            return []
          throw error
        })
        if (this.#disposed)
          return
        if (version !== this.#version)
          continue
        this.replace(items)
        const publishedVersion = this.#version
        await this.#inbox.reconcileReadState(recoveryNotificationPrefix)
        if (publishedVersion === this.#version)
          return
      }
    }
    catch (error) {
      this.#onError(error)
    }
    finally {
      this.#refreshing = undefined
    }
  }

  dispose() {
    this.#disposed = true
    clearTimeout(this.#recheck)
  }
}
