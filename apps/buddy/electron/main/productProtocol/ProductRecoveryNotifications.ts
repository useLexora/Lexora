import type { ProductRecoveryItem } from '../../../shared/runtime/productRecovery'
import type { DesktopNotificationInbox } from '../notifications/DesktopNotificationInbox'
import type { DesktopCommandOutcome } from './DesktopProductCommands'
import { recoveryNotificationPrefix } from '../../shared/desktopNotifications'
import { productOutboxRecordId } from './ProductOutboxStore'

export function recoveryState(outcome: DesktopCommandOutcome): ProductRecoveryItem['state'] {
  if (outcome.state === 'decided')
    return outcome.record.receipt!.decision
  return outcome.state === 'connection_replaced' ? 'unknown' : outcome.state
}

export class ProductRecoveryNotifications {
  readonly #inbox: DesktopNotificationInbox
  readonly #outcomes: () => Promise<DesktopCommandOutcome[]>
  readonly #onError: (error: unknown) => void
  readonly #published = new Set<string>()
  #version = 0
  #refreshing: Promise<void> | undefined
  #recheck: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(inbox: DesktopNotificationInbox, outcomes: () => Promise<DesktopCommandOutcome[]>, onError: (error: unknown) => void) {
    this.#inbox = inbox
    this.#outcomes = outcomes
    this.#onError = onError
  }

  publish(outcome: DesktopCommandOutcome) {
    if (this.#disposed)
      return
    this.#version++
    const recoveryId = productOutboxRecordId(outcome.record)
    const state = recoveryState(outcome)
    this.#published.add(recoveryId)
    this.#inbox.publish({
      id: recoveryNotificationPrefix + recoveryId,
      kind: 'operation.recovery',
      revision: state,
      occurredAt: outcome.record.createdAt,
      origin: 'desktop',
      lifecycle: 'active',
      action: { type: 'review-operation', recoveryId },
      presentation: { title: 'desktop.recovery.title', description: `desktop.recovery.${state}`, icon: 'messageRetry' },
    })
    if (state === 'unknown' && !this.#recheck) {
      this.#recheck = setTimeout(() => {
        this.#recheck = undefined
        void this.reconcile()
      }, 15_000)
      this.#recheck.unref()
    }
  }

  withdraw(id: string) {
    if (this.#refreshing || this.#published.has(id))
      this.#version++
    if (this.#published.delete(id))
      this.#inbox.withdraw(recoveryNotificationPrefix + id)
  }

  reconcile(): Promise<void> {
    this.#version++
    return this.#refreshing ??= this.#restore().catch(this.#onError).finally(() => {
      this.#refreshing = undefined
    })
  }

  async #restore() {
    while (!this.#disposed) {
      const version = this.#version
      const outcomes = await this.#outcomes()
      if (this.#disposed)
        return
      if (version !== this.#version)
        continue
      const active = new Set(outcomes.map(outcome => productOutboxRecordId(outcome.record)))
      for (const id of this.#published) {
        if (!active.has(id))
          this.withdraw(id)
      }
      for (const outcome of outcomes)
        this.publish(outcome)
      const publishedVersion = this.#version
      await this.#inbox.reconcileReadState(recoveryNotificationPrefix)
      if (publishedVersion === this.#version)
        return
    }
  }

  dispose() {
    this.#disposed = true
    clearTimeout(this.#recheck)
  }
}
