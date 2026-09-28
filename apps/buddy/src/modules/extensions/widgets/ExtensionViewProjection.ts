import type { ExtensionViewNotification } from '@buddy-shared/extensions/extensionEvents'
import type { ExtensionViewPolicy, ExtensionViewSnapshot, ExtensionViewSynchronization, ExtensionViewUpdate } from '@buddy-shared/extensions/extensionViewProjection'
import { Emitter } from '@buddy-shared/events/Emitter'
import { ownExtensionViewSnapshot, projectExtensionViewEvent } from '@buddy-shared/extensions/extensionViewProjection'

export class ExtensionViewProjection {
  readonly #policy: ExtensionViewPolicy
  readonly #streamId = crypto.randomUUID()
  readonly #changes = new Emitter<ExtensionViewUpdate>(() => console.error('EXTENSION_VIEW_DELIVERY_FAILED'))
  readonly onDidChange = this.#changes.event
  #snapshot: ExtensionViewSnapshot
  #sequence = 0
  #disposed = false

  constructor(snapshot: ExtensionViewSnapshot, policy: ExtensionViewPolicy) {
    this.#policy = Object.freeze({ ...policy })
    this.#snapshot = ownExtensionViewSnapshot(snapshot, policy)
  }

  get synchronization(): ExtensionViewSynchronization {
    return Object.freeze({ streamId: this.#streamId, sequence: this.#sequence, snapshot: this.#snapshot })
  }

  publish(input: ExtensionViewNotification): void {
    if (this.#disposed)
      return
    const projected = projectExtensionViewEvent(this.#snapshot, input, this.#policy)
    if (!projected)
      return
    this.#snapshot = projected.snapshot
    this.#changes.fire(Object.freeze({ streamId: this.#streamId, sequence: ++this.#sequence, event: projected.event }))
  }

  dispose(): void {
    this.#disposed = true
    this.#changes.dispose()
  }
}
