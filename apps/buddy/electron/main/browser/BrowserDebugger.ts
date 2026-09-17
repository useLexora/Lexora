export interface BrowserDebuggerPort {
  attach: (protocolVersion?: string) => void
  detach: () => void
  isAttached: () => boolean
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

export class BrowserDebugger {
  readonly #port: BrowserDebuggerPort
  #ownsAttachment = false

  constructor(port: BrowserDebuggerPort) {
    this.#port = port
  }

  ensureAttached(): void {
    if (this.#port.isAttached())
      return
    this.#port.attach('1.3')
    this.#ownsAttachment = true
  }

  sendCommand(...args: Parameters<BrowserDebuggerPort['sendCommand']>): Promise<unknown> {
    return this.#port.sendCommand(...args)
  }

  dispose(): void {
    if (this.#ownsAttachment && this.#port.isAttached())
      this.#port.detach()
    this.#ownsAttachment = false
  }
}
