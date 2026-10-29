import type { SpeechApi, SpeechEvent, SpeechPayload, SpeechProvider, SpeechStart } from '@buddy-shared/speech/speechApi'

export class SpeechConnection {
  readonly id = crypto.randomUUID()
  readonly abort = new AbortController()
  readonly done: Promise<Extract<SpeechEvent, { type: 'ended' }>>
  readonly ready: Promise<void>
  readonly #started: Promise<void>
  #unsubscribe: () => void
  #resolveReady!: () => void
  #rejectReady!: (error: unknown) => void
  #resolveDone!: (event: Extract<SpeechEvent, { type: 'ended' }>) => void
  readonly provider: SpeechProvider
  readonly api: SpeechApi
  constructor(api: SpeechApi, provider: SpeechProvider, text: string | undefined, receive: (payload: SpeechPayload, signal: AbortSignal) => void | Promise<void>) {
    this.provider = provider
    this.api = api
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve
    })
    void this.ready.catch(() => {})
    this.#unsubscribe = api.onEvent((event) => {
      if (event.id !== this.id)
        return
      if (event.type === 'ended') {
        this.#end(event)
        return
      }
      void (async () => {
        try {
          if (this.abort.signal.aborted)
            return
          if (event.payload.type === 'ready')
            this.#resolveReady()
          await receive(event.payload, this.abort.signal)
        }
        catch (error) {
          this.abort.abort(error)
          void this.cancel()
          this.#end({ type: 'ended', id: this.id, status: 'failed', error: 'SPEECH_PLAYBACK_FAILED' })
        }
        finally { api.acknowledge(event.id, event.sequence) }
      })()
    })
    const input: SpeechStart = { id: this.id, kind: provider.kind, provider: { id: provider.id, revision: provider.revision }, ...(text !== undefined ? { text } : {}) }
    this.#started = api.start(input).catch((error) => {
      this.#end({ type: 'ended', id: this.id, status: 'failed', error: error instanceof Error ? error.message : 'SPEECH_FAILED' })
    })
  }

  #end(event: Extract<SpeechEvent, { type: 'ended' }>) {
    this.#unsubscribe()
    this.#rejectReady(new Error(event.error ?? 'SPEECH_SESSION_ENDED'))
    this.#resolveDone(event)
  }

  async cancel(): Promise<void> {
    this.abort.abort(new Error('SPEECH_CANCELLED'))
    await this.api.cancel(this.id).catch(() => {})
    await this.#started
    await this.api.cancel(this.id).catch(() => {})
    this.#end({ type: 'ended', id: this.id, status: 'cancelled' })
  }
}
