import type { ExtensionViewSession } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionViewHostMessage } from '@buddy-shared/extensions/extensionEvents'
import { CLOSE_PREPARATION_TIMEOUT_MS } from '@buddy-shared/lifecycle/closePreparation'

export class ExtensionCloseRequests {
  readonly #pending = new Map<string, { session: ExtensionViewSession, result: Promise<boolean>, finish: (allowed: boolean) => void, cancel: () => void }>()
  readonly #send: (session: ExtensionViewSession, message: ExtensionViewHostMessage) => void
  readonly #current: (session: ExtensionViewSession) => boolean

  constructor(send: (session: ExtensionViewSession, message: ExtensionViewHostMessage) => void, current: (session: ExtensionViewSession) => boolean) {
    this.#send = send
    this.#current = current
  }

  request(session: ExtensionViewSession, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || !this.#current(session))
      return Promise.resolve(false)
    const existing = [...this.#pending.values()].find(pending => pending.session === session)
    if (existing)
      return this.#observe(existing, signal)
    const id = crypto.randomUUID()
    let resolve!: (allowed: boolean) => void
    const result = new Promise<boolean>((done) => {
      resolve = done
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (allowed: boolean) => {
      if (!this.#pending.delete(id))
        return
      clearTimeout(timer)
      resolve(allowed)
    }
    const cancel = () => {
      this.#send(session, { closeCancel: id })
      finish(false)
    }
    timer = setTimeout(cancel, CLOSE_PREPARATION_TIMEOUT_MS)
    const pending = { session, result, finish, cancel }
    this.#pending.set(id, pending)
    this.#observe(pending, signal)
    this.#send(session, { closeRequest: { id } })
    return result
  }

  #observe(pending: { result: Promise<boolean>, cancel: () => void }, signal?: AbortSignal): Promise<boolean> {
    if (signal) {
      signal.addEventListener('abort', pending.cancel, { once: true })
      void pending.result.finally(() => signal.removeEventListener('abort', pending.cancel))
    }
    return pending.result
  }

  receive(session: ExtensionViewSession, result: unknown): void {
    if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string' || !('allowed' in result) || typeof result.allowed !== 'boolean')
      return
    const pending = this.#pending.get(result.id)
    if (pending?.session === session)
      pending.finish(this.#current(session) && result.allowed)
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
