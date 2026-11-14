import type { ReaderUpdate, ReaderWireEntry } from './readerProtocol'

export class ReaderProjection {
  #topic = ''
  #items = new Map<string, ReaderWireEntry>()
  #order: string[] = []
  #transcripts: NonNullable<ReaderUpdate['transcripts']> = {}

  apply(update: ReaderUpdate) {
    const reset = update.reset || update.topic !== this.#topic
    if (reset) {
      this.#items.clear()
      this.#order = []
      this.#transcripts = {}
    }
    this.#topic = update.topic
    if (update.transcripts) {
      const next = { ...this.#transcripts }
      for (const [id, transcript] of Object.entries(update.transcripts))
        next[id] = { ...transcript, events: transcript.append ? [...next[id]?.events ?? [], ...transcript.events] : transcript.events }
      this.#transcripts = next
    }
    if (update.order) {
      this.#order = update.order
      const retained = new Set(this.#order)
      for (const id of this.#items.keys()) {
        if (!retained.has(id))
          this.#items.delete(id)
      }
    }
    for (const entry of update.entries)
      this.#items.set(entry.id, entry)
    return { reset, entries: this.#order.flatMap(id => this.#items.get(id) ?? []), transcripts: this.#transcripts }
  }
}
