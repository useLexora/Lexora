type CloseHandler = (signal: AbortSignal) => boolean | Promise<boolean>

export class ExtensionCloseGuard {
  #handler: CloseHandler | undefined
  #pending: { id: string, abort: AbortController } | undefined
  readonly #reply: (id: string, allowed: boolean) => void

  constructor(reply: (id: string, allowed: boolean) => void) {
    this.#reply = reply
  }

  register(handler: CloseHandler): { dispose: () => void } {
    if (this.#handler)
      throw new Error('EXTENSION_CLOSE_HANDLER_EXISTS')
    this.#handler = handler
    return { dispose: () => {
      if (this.#handler === handler) {
        this.#handler = undefined
        this.#cancel()
      }
    } }
  }

  async request(id: string): Promise<void> {
    this.#cancel()
    const pending = { id, abort: new AbortController() }
    this.#pending = pending
    let allowed = false
    try {
      allowed = this.#handler ? await this.#handler(pending.abort.signal) === true : true
    }
    catch {}
    if (this.#pending !== pending)
      return
    this.#pending = undefined
    this.#reply(id, allowed)
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
