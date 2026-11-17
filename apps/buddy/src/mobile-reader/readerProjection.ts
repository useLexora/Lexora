import type { ReaderUpdate, ReaderWireEntry } from './readerProtocol'

export interface ReaderAnchor { topic: string, messageId: string, requestId: string }

export class ReaderProjection {
  #topic = ''
  #anchor: ReaderAnchor | null = null
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
    if (update.anchorRequestId && update.anchorMessageId) {
      if (this.#anchor?.requestId !== update.anchorRequestId)
        this.#anchor = { topic: update.topic, requestId: update.anchorRequestId, messageId: update.anchorMessageId }
    }
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
    return {
      reset,
      entries: this.#order.flatMap(id => this.#items.get(id) ?? []),
      transcripts: this.#transcripts,
      anchor: update.anchorRequestId && update.anchorMessageId && this.#anchor?.topic === update.topic ? this.#anchor : null,
    }
  }
}
