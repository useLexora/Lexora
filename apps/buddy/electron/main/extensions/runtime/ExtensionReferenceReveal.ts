import type { ExtensionReferenceReveal as ReferenceReveal } from '../../../../shared/extensions/extensionReferences'
import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'

type RevealHandler = (input: ReferenceReveal, signal: AbortSignal) => boolean | Promise<boolean>

export class ExtensionReferenceReveal {
  #handler: RevealHandler | undefined
  #pending: { id: string, abort: AbortController } | undefined
  readonly #reply: (id: string, located: boolean) => void

  constructor(reply: (id: string, located: boolean) => void) {
    this.#reply = reply
  }

  onReveal(handler: RevealHandler): { dispose: () => void } {
    if (this.#handler)
      throw new Error('EXTENSION_REFERENCE_HANDLER_EXISTS')
    this.#handler = handler
    return { dispose: () => {
      if (this.#handler === handler) {
        this.#handler = undefined
        this.#cancel()
      }
    } }
  }

  async reveal(id: string, input: ReferenceReveal): Promise<void> {
    this.#cancel()
    const pending = { id, abort: new AbortController() }
    this.#pending = pending
    let located = false
    try {
      located = await this.#handler?.(copyEventSnapshot(input), pending.abort.signal) === true
    }
    catch {}
    if (this.#pending !== pending)
      return
    this.#pending = undefined
    this.#reply(id, located)
  }

  cancel(id: string): void {
    if (this.#pending?.id === id)
      this.#cancel()
  }

  #cancel(): void {
    const pending = this.#pending
    if (!pending)
      return
    this.#pending = undefined
    pending.abort.abort()
    this.#reply(pending.id, false)
  }

  dispose(): void {
    this.#handler = undefined
    this.#cancel()
  }
}
