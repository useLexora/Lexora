import type { Api, Model, Usage } from '@earendil-works/pi-ai'
import type { WebErrorCode } from '../../../shared/network/webProtocol'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { NativeSearchModels } from './NativeWebSearch'
import type { WebCapabilityChange, WebOperationObserver } from './WebCapabilityEvents'
import type { WebDocument } from './webContent'
import type { WebHostClient } from './WebHostClient'
import type { WebSearchResponse } from './webSearchBackends'
import type { WebSettingsService } from './WebSettingsService'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { publicWebUrl } from '../../../platform/network/publicWebTransport'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { WebError, webError } from '../../../shared/network/webProtocol'
import { githubWebFetch } from './githubWebFetch'
import { nativeSearchFamily, nativeWebSearch } from './NativeWebSearch'
import { extractHtml, extractWebResource } from './webContent'
import { WebContentCache } from './WebContentCache'
import { publicWebSearch, tavilyRequest, tavilySearch } from './webSearchBackends'

interface WebAttempt { provider: string, code: WebErrorCode | null, durationMs: number }
interface WebFailure { ok: false, code: WebErrorCode, provider: string | null, attempts: WebAttempt[] }
type SearchResult = (WebFailure | (WebSearchResponse & { ok: true, query: string, provider: string, attempts: WebAttempt[] })) & { availableProviders: string[], modelUsage?: Usage }
type FetchResult = (WebFailure | (WebDocument & { ok: true, provider: string, mode: 'http' | 'render' | 'remote', outputTruncated: boolean, contentPath: string | null, attempts: WebAttempt[] })) & { availableProviders: string[] }

export interface WebCapabilityOptions {
  host: Pick<WebHostClient, 'get' | 'providerFetch' | 'render' | 'authorize'>
  models: NativeSearchModels
  settings: Pick<WebSettingsService, 'get' | 'getTavilyKey'>
  paths: BuddyDataPaths
}

const STOP_FETCH_FALLBACK = new Set<WebErrorCode>([
  'WEB_ACCESS_DENIED',
  'WEB_CHALLENGE',
  'WEB_URL_BLOCKED',
  'WEB_UNSUPPORTED_CONTENT',
  'WEB_RESPONSE_TOO_LARGE',
  'WEB_CACHE_FAILED',
])

export class WebCapabilityService {
  readonly #changes = new Emitter<WebCapabilityChange>(() => console.error('WEB_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #pending = new Map<string, { kind: 'search' | 'fetch', promise: Promise<unknown> }>()
  #revision = 0
  #disposing: Promise<void> | undefined
  readonly #options: WebCapabilityOptions
  readonly #shutdown = new AbortController()
  readonly #cache: WebContentCache
  #active = 0

  constructor(options: WebCapabilityOptions) {
    this.#options = options
    this.#cache = new WebContentCache(options.paths)
  }

  get snapshot() { return copyEventSnapshot({ revision: this.#revision, stopping: this.#shutdown.signal.aborted, active: [...this.#pending].map(([operationId, entry]) => ({ operationId, kind: entry.kind })) }) }

  async search(input: { query: string, provider?: string, model?: Model<Api>, signal?: AbortSignal }): Promise<SearchResult> {
    let availableProviders: string[] = []
    let modelUsage: Usage | undefined
    const nativeId = input.model && nativeSearchFamily(input.model) ? `${input.model.provider}-native` : null
    const enabled = (provider: string) => this.#options.settings.get().search.some(source => source.enabled && source.provider === (provider === nativeId ? 'native' : provider))
    const result = await this.#run('search', input.signal, async (signal, attempts, publish) => {
      const sources = this.#options.settings.get().search
      const hasKey = sources.some(source => source.provider === 'tavily' && source.enabled) && await this.#hasTavilyKey()
      const routes = sources.filter(source => source.enabled && (source.provider !== 'native' || nativeId) && (source.provider !== 'tavily' || hasKey))
        .map(source => ({ provider: source.provider, id: source.provider === 'native' ? nativeId! : source.provider }))
      availableProviders = routes.map(route => route.id)
      const requested = input.provider === 'native' ? nativeId ?? 'native' : input.provider
      const selected = !requested || requested === 'auto' ? routes : routes.filter(route => route.id === requested)
      if (!selected.length)
        throw new WebError('WEB_PROVIDER_UNAVAILABLE')
      let last: WebSearchResponse | undefined
      for (const route of selected) {
        const provider = route.id
        signal.throwIfAborted()
        if (!enabled(provider))
          continue
        const started = Date.now()
        const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(provider === nativeId ? 50_000 : 15_000)])
        publish({ phase: 'attempt-started', provider: route.provider, attempt: attempts.length + 1 })
        try {
          const providerFetch: WebHostClient['providerFetch'] = (url, init) => {
            if (!enabled(provider))
              throw new WebError('WEB_PROVIDER_UNAVAILABLE')
            return this.#options.host.providerFetch(url, init)
          }
          const result = route.provider === 'native'
            ? await nativeWebSearch(providerFetch, this.#options.models, input.model!, input.query, attemptSignal, (usage) => { modelUsage = usage })
            : route.provider === 'tavily'
              ? await tavilySearch(providerFetch, input.query, await this.#key(), attemptSignal)
              : await publicWebSearch(this.#options.host.get, route.provider, input.query, attemptSignal)
          attempts.push({ provider, code: null, durationMs: Date.now() - started })
          publish({ phase: 'attempt-finished', provider: route.provider, attempt: attempts.length, count: result.sources.length, durationMs: Date.now() - started })
          if (result.sources.length)
            return { ...result, ok: true as const, provider, query: input.query, attempts }
          last = result
        }
        catch (error) {
          const errorCode = webError(error, attemptSignal).code
          attempts.push({ provider, code: errorCode, durationMs: Date.now() - started })
          publish({ phase: 'attempt-finished', provider: route.provider, attempt: attempts.length, errorCode, durationMs: Date.now() - started })
        }
      }
      signal.throwIfAborted()
      if (last && attempts.at(-1)?.code === null)
        return { ...last, ok: true as const, provider: attempts.at(-1)!.provider, query: input.query, attempts }
      throw new WebError(attempts.at(-1)?.code ?? 'WEB_EMPTY_CONTENT')
    })
    return { ...result, ...(modelUsage ? { modelUsage } : {}), availableProviders: availableProviders.filter(enabled) }
  }

  async fetch(input: { url: string, provider?: string, conversationId: string, signal?: AbortSignal }): Promise<FetchResult> {
    let availableProviders: string[] = []
    const result = await this.#run('fetch', input.signal, async (signal, attempts, publish) => {
      const url = publicWebUrl(input.url)
      const settings = this.#options.settings.get().fetch
      const hasKey = settings.remote && await this.#hasTavilyKey()
      const routes: Array<'local' | 'tavily'> = ['local', ...(hasKey ? ['tavily' as const] : [])]
      availableProviders = routes
      const selected = !input.provider || input.provider === 'auto' ? routes : routes.filter(provider => provider === input.provider)
      if (!selected.length)
        throw new WebError('WEB_PROVIDER_UNAVAILABLE')
      await this.#options.host.authorize(url.href, signal)
      for (const provider of selected) {
        signal.throwIfAborted()
        if (provider === 'tavily' && !this.#options.settings.get().fetch.remote)
          continue
        const started = Date.now()
        const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(provider === 'local' ? 45_000 : 20_000)])
        publish({ phase: 'attempt-started', provider, attempt: attempts.length + 1 })
        try {
          let document: WebDocument
          let mode: 'http' | 'render' | 'remote' = provider === 'local' ? 'http' : 'remote'
          if (provider === 'local') {
            try {
              document = await githubWebFetch(this.#options.host.get, url, attemptSignal)
                ?? await extractWebResource(await this.#options.host.get(url.href, attemptSignal), attemptSignal)
            }
            catch (error) {
              const failure = webError(error, attemptSignal)
              if (failure.code !== 'WEB_RENDER_REQUIRED' || !this.#options.settings.get().fetch.render)
                throw failure
              publish({ phase: 'render-fallback', provider, mode: 'render', attempt: attempts.length + 1 })
              const rendered = await this.#options.host.render(url.href, attemptSignal)
              if (!rendered.ok)
                throw new WebError(rendered.code)
              document = extractHtml(rendered.html, rendered.url)
              mode = 'render'
            }
          }
          else {
            const providerFetch: WebHostClient['providerFetch'] = (url, init) => {
              if (!this.#options.settings.get().fetch.remote)
                throw new WebError('WEB_PROVIDER_UNAVAILABLE')
              return this.#options.host.providerFetch(url, init)
            }
            const result = z.object({
              results: z.array(z.object({ url: z.string(), raw_content: z.string() })),
              failed_results: z.array(z.unknown()).optional(),
              usage: z.object({ credits: z.number().nonnegative() }).optional(),
            }).safeParse(await tavilyRequest(providerFetch, 'extract', await this.#key(), {
              urls: [url.href],
              extract_depth: 'basic',
              format: 'markdown',
              include_usage: true,
            }, attemptSignal))
            if (!result.success)
              throw new WebError('WEB_INVALID_RESPONSE')
            const extracted = result.data.results[0]
            if (!extracted?.raw_content.trim())
              throw new WebError('WEB_EMPTY_CONTENT')
            document = { url: publicWebUrl(extracted.url).href, title: extracted.url, content: extracted.raw_content, contentType: 'text/markdown', acquisitionIncomplete: true, warnings: ['Remote extraction does not guarantee complete page coverage.'], handler: 'text' }
            if (result.data.usage)
              document.usage = { credits: result.data.usage.credits, cost: null }
          }
          attemptSignal.throwIfAborted()
          publish({ phase: 'received', provider, mode, count: Buffer.byteLength(document.content) })
          const output = await this.#publish(document, input.conversationId, attemptSignal, publish)
          attempts.push({ provider, code: null, durationMs: Date.now() - started })
          publish({ phase: 'attempt-finished', provider, mode, attempt: attempts.length, durationMs: Date.now() - started })
          return { ...output, ok: true as const, provider, mode, attempts }
        }
        catch (error) {
          const failure = webError(error, attemptSignal)
          attempts.push({ provider, code: failure.code, durationMs: Date.now() - started })
          publish({ phase: 'attempt-finished', provider, attempt: attempts.length, errorCode: failure.code, durationMs: Date.now() - started })
          if (STOP_FETCH_FALLBACK.has(failure.code))
            throw failure
        }
      }
      signal.throwIfAborted()
      throw new WebError(attempts.at(-1)?.code ?? 'WEB_PROVIDER_UNAVAILABLE')
    })
    return { ...result, availableProviders: availableProviders.filter(provider => provider === 'local' || this.#options.settings.get().fetch.remote) }
  }

  dispose(): Promise<void> {
    if (this.#disposing)
      return this.#disposing
    this.#disposing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#pending.values()].map(entry => entry.promise))
      await this.#cache.dispose()
      this.#changes.dispose()
    })
    this.#shutdown.abort()
    return this.#disposing
  }

  async #hasTavilyKey(): Promise<boolean> {
    return Boolean(await this.#options.settings.getTavilyKey().catch(() => null))
  }

  async #key(): Promise<string> {
    const key = await this.#options.settings.getTavilyKey()
    if (!key)
      throw new WebError('WEB_PROVIDER_UNAVAILABLE')
    return key
  }

  async #publish(document: WebDocument, conversationId: string, signal: AbortSignal, publish: WebOperationObserver): Promise<WebDocument & { outputTruncated: boolean, contentPath: string | null }> {
    const bytes = Buffer.from(document.content)
    if (bytes.byteLength > 4 * 1024 * 1024)
      throw new WebError('WEB_RESPONSE_TOO_LARGE')
    if (bytes.byteLength <= 24 * 1024)
      return { ...document, outputTruncated: false, contentPath: null }
    const receipt = await this.#cache.write(conversationId, `Source: ${document.url}\nUntrusted external content.\n\n${document.content}`, signal).catch(() => {
      throw new WebError('WEB_CACHE_FAILED')
    })
    publish({ phase: 'cache-published', count: receipt.bytes, cancelled: signal.aborted })
    if (receipt.cleanup === 'failed')
      publish({ phase: 'cache-cleanup-failed', errorCode: 'WEB_CACHE_FAILED', count: receipt.removed })
    let end = 24 * 1024
    while ((bytes[end]! & 0xC0) === 0x80)
      end--
    return { ...document, content: bytes.subarray(0, end).toString('utf8'), outputTruncated: true, contentPath: receipt.path }
  }

  #run<T>(kind: 'search' | 'fetch', parent: AbortSignal | undefined, operation: (signal: AbortSignal, attempts: WebAttempt[], publish: WebOperationObserver) => Promise<T>): Promise<T | WebFailure> {
    const attempts: WebAttempt[] = []
    if (this.#shutdown.signal.aborted)
      return Promise.resolve({ ok: false, provider: null, code: 'WEB_CANCELLED', attempts })
    if (this.#active >= 4)
      return Promise.resolve({ ok: false, provider: null, code: 'WEB_BUSY', attempts })
    this.#active++
    const operationId = randomUUID()
    const publish: WebOperationObserver = fact => this.#changes.fire(copyEventSnapshot({ ...fact, kind, operationId, revision: ++this.#revision }))
    const signal = AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(90_000), ...(parent ? [parent] : [])])
    const accepted = Promise.resolve().then(async (): Promise<T | WebFailure> => {
      let outcome: 'completed' | 'failed' = 'completed'
      const started = performance.now()
      publish({ phase: 'started' })
      try {
        signal.throwIfAborted()
        return await operation(signal, attempts, publish)
      }
      catch (error) {
        outcome = 'failed'
        return { ok: false, provider: attempts.at(-1)?.provider ?? null, code: webError(error, signal).code, attempts }
      }
      finally {
        this.#active--
        this.#pending.delete(operationId)
        publish({ phase: 'settled', outcome, cancelled: signal.aborted, durationMs: Math.round(performance.now() - started) })
      }
    })
    this.#pending.set(operationId, { kind, promise: accepted })
    return accepted
  }
}
