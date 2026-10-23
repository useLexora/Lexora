import type { ExtensionViewSession } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionViewHostMessage } from '@buddy-shared/extensions/extensionEvents'
import type { ExtensionReferenceReveal } from '@buddy-shared/extensions/extensionReferences'

export class ExtensionReferenceRequests {
  readonly #pending = new Map<string, { session: ExtensionViewSession, finish: (located: boolean) => void, cancel: () => void }>()
  readonly #send: (session: ExtensionViewSession, message: ExtensionViewHostMessage) => void
  readonly #current: (session: ExtensionViewSession) => boolean

  constructor(send: (session: ExtensionViewSession, message: ExtensionViewHostMessage) => void, current: (session: ExtensionViewSession) => boolean) {
    this.#send = send
    this.#current = current
  }

  request(session: ExtensionViewSession, input: ExtensionReferenceReveal, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !this.#current(session))
      return Promise.resolve(false)
    return new Promise((resolve) => {
      const id = crypto.randomUUID()
      let cancel: () => void
      const finish = (located: boolean) => {
        this.#pending.delete(id)
        signal.removeEventListener('abort', cancel)
        resolve(located)
      }
      cancel = () => {
        this.#send(session, { referenceCancel: id })
        finish(false)
      }
      this.#pending.set(id, { session, finish, cancel })
      signal.addEventListener('abort', cancel, { once: true })
      this.#send(session, { referenceRequest: { id, input } })
    })
  }

  receive(session: ExtensionViewSession, result: unknown): void {
    if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string' || !('located' in result) || typeof result.located !== 'boolean')
      return
    const pending = this.#pending.get(result.id)
    if (pending?.session === session)
      pending.finish(this.#current(session) && result.located)
  }

  reconcile(): void {
    for (const pending of this.#pending.values()) {
      if (!this.#current(pending.session))
        pending.cancel()
    }
  }

  dispose(): void {
    for (const pending of this.#pending.values()) pending.cancel()
  }
}
