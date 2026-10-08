import type { AssistantMessage, Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream, normalizeContext } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MODEL_PROGRESS_TIMEOUT_MS, withProviderStream } from '../withProviderStream'

const model: Model<'openai-completions'> = { api: 'openai-completions', provider: 'fixture', id: 'fixture', name: 'Fixture', reasoning: true, input: ['text'], baseUrl: 'https://fixture.example.test', contextWindow: 4096, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
const context = normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }] })
afterEach(() => vi.useRealTimers())

function fixture(signal?: AbortSignal) {
  vi.useFakeTimers()
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
    expect(await f.result).toMatchObject({ stopReason: 'aborted', content: [{ type: 'text', text: 'partial' }] })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves committed content when an iterator throws instead of emitting a terminal error', async () => {
    vi.useFakeTimers()
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
