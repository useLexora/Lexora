import type { AssistantMessage, Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream, isRetryableAssistantError, normalizeContext, retryAssistantCall } from '@earendil-works/pi-ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeModelRequestFailure } from '../modelRequestFailure'
import { MODEL_PROGRESS_TIMEOUT_MS, withProviderStream } from '../withProviderStream'

const model: Model<'openai-completions'> = { api: 'openai-completions', provider: 'fixture', id: 'fixture', name: 'Fixture', reasoning: true, input: ['text'], baseUrl: 'https://fixture.example.test', contextWindow: 4096, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
const context = normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }] })
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fixture(signal?: AbortSignal) {
  const source = createAssistantMessageEventStream()
  const partial: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop', content: [], usage: { input: 1, output: 0, totalTokens: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
  let options!: StreamOptions
  const stream: Provider['stream'] = (_model, _context, value) => {
    options = value!
    source.push({ type: 'start', partial })
    return source
  }
  const provider = withProviderStream({ id: 'fixture', name: 'Fixture', stream, streamSimple: stream } as Provider)
  const result = provider.stream(model, context, { signal }).result()
  return {
    result,
    source,
    partial,
    options: () => options,
    text(text: string) {
      partial.content = [{ type: 'text', text }]
      source.push({ type: 'text_delta', contentIndex: 0, delta: text, partial })
    },
    done() {
      source.push({ type: 'done', reason: 'stop', message: partial })
    },
  }
}

describe('provider stream progress deadline', () => {
  it('does not let empty transport heartbeats extend the deadline and aborts the producer', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 2; index++) {
      await vi.advanceTimersByTimeAsync(100_000)
      await f.options().onProviderStreamEvent?.({ id: 'heartbeat', choices: [{ delta: { role: 'assistant' } }] }, model)
    }
    await vi.advanceTimersByTimeAsync(100_000)
    expect(await f.result).toMatchObject({ stopReason: 'error', errorMessage: 'Model stream timeout: no model progress for 300 seconds' })
    expect(f.options().signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renews the deadline for text and preserves committed text if the stream later stalls', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(MODEL_PROGRESS_TIMEOUT_MS - 1)
    f.text('committed answer')
    await vi.advanceTimersByTimeAsync(MODEL_PROGRESS_TIMEOUT_MS - 1)
    expect(f.options().signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await f.result).toMatchObject({ stopReason: 'error', content: [{ type: 'text', text: 'committed answer' }] })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles caller cancellation even if a provider ignores its abort signal', async () => {
    const controller = new AbortController()
    const f = fixture(controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    f.text('partial')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    const result = await f.result
    expect(result).toMatchObject({ stopReason: 'aborted', content: [{ type: 'text', text: 'partial' }] })
    expect(isRetryableAssistantError(result)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['stream aborted', 'Request was aborted', undefined])('treats an upstream abort as a retryable interruption: %s', async (errorMessage) => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(0)
    f.source.push({ type: 'error', reason: 'aborted', error: { ...f.partial, stopReason: 'aborted', errorMessage } })
    const result = await f.result
    expect(result.stopReason).toBe('error')
    expect(normalizeModelRequestFailure(result).code).toBe('MODEL_STREAM_INCOMPLETE')
    expect(isRetryableAssistantError(result)).toBe(true)
    if (errorMessage)
      expect(result.errorMessage).toContain(errorMessage)
    expect(f.options().signal?.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { failures: 2, attempts: 3, stopReason: 'stop' },
    { failures: 4, attempts: 4, stopReason: 'error' },
  ])('settles $failures upstream interruptions within the retry budget', async ({ failures, attempts, stopReason }) => {
    let requests = 0
    const response = retryAssistantCall(() => {
      const f = fixture()
      if (++requests <= failures) {
        f.source.push({ type: 'error', reason: 'aborted', error: { ...f.partial, stopReason: 'aborted', errorMessage: 'stream aborted' } })
      }
      else {
        f.text('recovered answer')
        f.done()
      }
      return f.result
    }, { enabled: true, maxRetries: 3, baseDelayMs: 10 }, undefined)
    await vi.advanceTimersByTimeAsync(100)
    const result = await response
    expect(result).toMatchObject({ stopReason, content: stopReason === 'stop' ? [{ type: 'text', text: 'recovered answer' }] : [] })
    if (stopReason === 'error')
      expect(normalizeModelRequestFailure(result).code).toBe('MODEL_STREAM_INCOMPLETE')
    expect(requests).toBe(attempts)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves committed content when an iterator throws instead of emitting a terminal error', async () => {
    const partial: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop', content: [{ type: 'text', text: 'committed' }], usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } }
    const stream = () => ({
      async* [Symbol.asyncIterator]() {
        yield { type: 'text_delta' as const, delta: 'committed', contentIndex: 0, partial }
        throw new Error('socket hang up')
      },
    })
    const provider = withProviderStream({ id: 'fixture', name: 'Fixture', stream, streamSimple: stream } as unknown as Provider)
    expect(await provider.stream(model, context).result()).toMatchObject({ stopReason: 'error', errorMessage: 'socket hang up', content: [{ type: 'text', text: 'committed' }] })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    [new TypeError('fetch failed: authentication failed', { cause: Object.assign(new Error('private cause'), { code: 'ECONNRESET' }) }), true],
    [new Error('fetch failed: CERT_HAS_EXPIRED'), false],
    [new Error('Connection error: self-signed certificate'), false],
  ] as const)('retains failure evidence before any partial message: %s', async (failure, retryable) => {
    const stream: Provider['stream'] = () => {
      throw failure
    }
    const provider = withProviderStream({ id: 'fixture', name: 'Fixture', auth: {}, getModels: () => [model], stream, streamSimple: stream })
    const result = await provider.stream(model, context).result()
    expect(result.stopReason).toBe('error')
    expect(normalizeModelRequestFailure(result).code).toBe('MODEL_SERVICE_UNREACHABLE')
    expect(JSON.stringify(result.diagnostics) ?? '').not.toContain('private')
    expect(isRetryableAssistantError(result)).toBe(retryable)
  })

  it('counts hidden reasoning as progress before display filtering', async () => {
    const event = { choices: [{ delta: { reasoning_content: 'hidden reasoning' } }] }
    const f = fixture()
    await vi.advanceTimersByTimeAsync(200_000)
    await f.options().onProviderStreamEvent?.(event, model)
    await vi.advanceTimersByTimeAsync(200_000)
    expect(f.options().signal?.aborted).toBe(false)
    f.done()
    expect(await f.result).toMatchObject({ stopReason: 'stop' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
