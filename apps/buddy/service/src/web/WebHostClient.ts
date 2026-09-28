import type { WebNetworkRequest, WebRenderResult } from '../../../shared/network/webProtocol'
import type { ProviderWebFetch, PublicWebGet } from '../../../shared/network/webTransport'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { readResponseBytes } from '../../../platform/network/publicWebTransport'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { WebError, webNetworkChunkSchema, webNetworkHeadSchema, webRenderResultSchema } from '../../../shared/network/webProtocol'

type WebHostRequestKind = 'authorization' | 'network' | 'render'
export interface WebHostChange {
  readonly revision: number
  readonly requestId: string
  readonly kind: WebHostRequestKind
  readonly phase: 'requested' | 'head-received' | 'cancel-requested' | 'cancel-unconfirmed' | 'settled'
  readonly outcome?: 'received' | 'rejected' | 'unknown'
  readonly cancelled?: boolean
  readonly count?: number
}

export class WebHostClient {
  readonly peer: Pick<RuntimeRpcPeerContract, 'request' | 'notify' | 'onNotification'>
  readonly #changes = new Emitter<WebHostChange>(() => console.error('WEB_HOST_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #shutdown = new AbortController()
  readonly #active = new Map<string, WebHostRequestKind>()
  readonly #pending = new Set<Promise<unknown>>()
  #revision = 0
  #disposing: Promise<void> | undefined

  constructor(peer: Pick<RuntimeRpcPeerContract, 'request' | 'notify' | 'onNotification'>) { this.peer = peer }

  get snapshot() {
    return copyEventSnapshot({ revision: this.#revision, stopping: this.#shutdown.signal.aborted, active: [...this.#active].map(([requestId, kind]) => ({ requestId, kind })) })
  }

  async authorize(url: string, parent?: AbortSignal): Promise<void> {
    const { requestId, signal } = this.#begin('authorization', parent)
    let outcome: WebHostChange['outcome'] = 'unknown'
    try {
      const result = z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true) }),
        webRenderResultSchema.options[1],
      ]).parse(await this.#track(this.peer.request('host.web.authorize', { url }, undefined, signal)))
      outcome = result.ok ? 'received' : 'rejected'
      if (!result.ok)
        throw new WebError(result.code)
    }
    finally { this.#finish(requestId, outcome, signal.aborted) }
  }

  get: PublicWebGet = async (url, signal, limit = 12 * 1024 * 1024) => {
    const result = await this.#request({ url, scope: 'public', method: 'GET', headers: {}, limit }, signal)
    return { bytes: await readResponseBytes(result.response, limit), headers: result.response.headers, status: result.response.status, url: result.url }
  }

  providerFetch: ProviderWebFetch = async (url, init) => {
    const result = await this.#request({ url, scope: 'provider', method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body, limit: 12 * 1024 * 1024 }, init.signal)
    return result.response
  }

  async render(url: string, parent: AbortSignal): Promise<WebRenderResult> {
    const { requestId, signal } = this.#begin('render', parent)
    const cancel = () => this.#cancel(requestId)
    signal.addEventListener('abort', cancel, { once: true })
    let outcome: WebHostChange['outcome'] = 'unknown'
    try {
      const result = webRenderResultSchema.parse(await this.#track(this.peer.request('host.web.render', { url, requestId }, 25_000, signal)))
      outcome = result.ok ? 'received' : 'rejected'
      signal.throwIfAborted()
      return result
    }
    finally {
      signal.removeEventListener('abort', cancel)
      if (outcome === 'unknown' && !signal.aborted)
        cancel()
      this.#finish(requestId, outcome, signal.aborted)
    }
  }

  dispose(): Promise<void> {
    if (this.#disposing)
      return this.#disposing
    this.#disposing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#pending])
      this.#changes.dispose()
    })
    this.#shutdown.abort()
    return this.#disposing
  }

  async #request(input: Omit<WebNetworkRequest, 'requestId'>, parent: AbortSignal): Promise<{ response: Response, url: string }> {
    const { requestId, signal } = this.#begin('network', parent)
    let controller: ReadableStreamDefaultController<Uint8Array>
    let finished = false
    let headSettled = false
    let bodyOutcome: NonNullable<WebHostChange['outcome']> = 'unknown'
    let received = 0
    let unsubscribe = () => {}
    const cleanup = (outcome: NonNullable<WebHostChange['outcome']>) => {
      if (finished)
        return
      finished = true
      unsubscribe()
      signal.removeEventListener('abort', cancel)
      bodyOutcome = outcome
      if (headSettled)
        this.#finish(requestId, outcome, signal.aborted, received)
    }
    const cancelRequest = () => this.#cancel(requestId)
    function cancel() {
      if (finished)
        return
      cancelRequest()
      controller.error(new WebError('WEB_CANCELLED'))
      cleanup('unknown')
    }
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
      cancel: () => {
        if (!finished)
          this.#cancel(requestId)
        cleanup('unknown')
      },
    })
    unsubscribe = this.peer.onNotification((method, params) => {
      if (method !== 'host.web.chunk' || finished)
        return
      const parsed = webNetworkChunkSchema.safeParse(params)
      if (!parsed.success || parsed.data.requestId !== requestId)
        return
      const message = parsed.data
      if (message.code) {
        controller.error(new WebError(message.code))
        cleanup('rejected')
      }
      else if (message.done) {
        controller.close()
        cleanup('received')
      }
      else if (message.chunk) {
        const bytes = Buffer.from(message.chunk, 'base64')
        received += bytes.byteLength
        if (received > input.limit) {
          this.#cancel(requestId)
          controller.error(new WebError('WEB_RESPONSE_TOO_LARGE'))
          cleanup('rejected')
        }
        else { controller.enqueue(bytes) }
      }
    })
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const result = webNetworkHeadSchema.parse(await this.#track(this.peer.request('host.web.request', { ...input, requestId }, 60_000, signal)))
      signal.throwIfAborted()
      headSettled = true
      if (!result.ok) {
        cleanup('rejected')
        this.#finish(requestId, 'rejected', signal.aborted, received)
        throw new WebError(result.code)
      }
      this.#publish(requestId, 'network', { phase: 'head-received' })
      if (finished)
        this.#finish(requestId, bodyOutcome, signal.aborted, received)
      const empty = [204, 205, 304].includes(result.status)
      const response = new Response(empty ? null : stream, { status: result.status, headers: result.headers })
      if (empty && !finished) {
        this.#cancel(requestId)
        cleanup('received')
      }
      return { response, url: result.url }
    }
    catch (error) {
      if (!finished)
        this.#cancel(requestId)
      headSettled = true
      cleanup('unknown')
      this.#finish(requestId, 'unknown', signal.aborted, received)
      await stream.cancel().catch(() => {})
      throw error
    }
  }

  #begin(kind: WebHostRequestKind, parent?: AbortSignal) {
    const signal = AbortSignal.any([this.#shutdown.signal, ...(parent ? [parent] : [])])
    signal.throwIfAborted()
    const requestId = randomUUID()
    this.#active.set(requestId, kind)
    this.#publish(requestId, kind, { phase: 'requested' })
    return { requestId, signal }
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise)
    void promise.finally(() => this.#pending.delete(promise)).catch(() => {})
    return promise
  }

  #finish(requestId: string, outcome: WebHostChange['outcome'], cancelled: boolean, count?: number): void {
    const kind = this.#active.get(requestId)
    if (!kind)
      return
    this.#active.delete(requestId)
    this.#publish(requestId, kind, { phase: 'settled', outcome, cancelled, ...(count === undefined ? {} : { count }) })
  }

  #cancel(requestId: string): void {
    const kind = this.#active.get(requestId)
    if (!kind)
      return
    this.#publish(requestId, kind, { phase: 'cancel-requested' })
    try {
      this.peer.notify('host.web.cancel', { requestId })
    }
    catch { this.#publish(requestId, kind, { phase: 'cancel-unconfirmed' }) }
  }

  #publish(requestId: string, kind: WebHostRequestKind, fact: Omit<WebHostChange, 'revision' | 'requestId' | 'kind'>): void {
    this.#changes.fire(copyEventSnapshot({ ...fact, kind, requestId, revision: ++this.#revision }))
  }
}
