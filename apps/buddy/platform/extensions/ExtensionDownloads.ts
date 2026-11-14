export class ExtensionDownloads {
  readonly #entries = new Map<string, { host: object, owner: string, abort: AbortController }>()

  async run<T>(id: string, host: object, owner: string, signals: AbortSignal[], operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#entries.has(id))
      throw new Error('EXTENSION_RESOURCE_DOWNLOAD_EXISTS')
    const abort = new AbortController()
    const entry = { host, owner, abort }
    this.#entries.set(id, entry)
    try {
      return await operation(AbortSignal.any([...signals, abort.signal]))
    }
    finally {
      this.#entries.delete(id)
    }
  }

  cancel(id: string, host: object, owner: string): void {
    const entry = this.#entries.get(id)
    if (!entry)
      return
    if (entry.host !== host || entry.owner !== owner)
      throw new Error('EXTENSION_RESOURCE_DENIED')
    entry.abort.abort(new Error('EXTENSION_RESOURCE_DOWNLOAD_CANCELLED'))
  }
}
