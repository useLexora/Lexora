import type { Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import { InMemoryCredentialStore, InMemoryModelsStore, normalizeContext } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { beforeAll, describe, expect, it } from 'vitest'
import { applicationDiagnosticSchema } from '../../../../shared/diagnostics/applicationDiagnostic'
import { PiApplicationObserver } from '../../agent/events/PiApplicationObserver'
import { INFERRED_STREAM_COMPLETION, withOpenAiStreamCompletion } from '../withOpenAiStreamCompletion'

const encoder = new TextEncoder()
const context = normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }] })
let provider: Provider
let model: Model<'openai-completions'>

beforeAll(async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
  runtime.registerProvider('fixture', {
    api: 'openai-completions',
    baseUrl: 'https://fixture.example.test/v1',
    models: [{ id: 'model', name: 'Model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }],
  })
  provider = withOpenAiStreamCompletion(runtime.getProvider('fixture')!)
  model = runtime.getModels('fixture')[0] as Model<'openai-completions'>
})

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function textDelta(content: string): string {
  return frame({ id: 'response-fixture', choices: [{ index: 0, delta: { content }, finish_reason: null }] })
}

function stream(body: ReadableStream<Uint8Array> | string, options: StreamOptions = {}) {
  return provider.stream(model, context, {
    apiKey: 'fixture-key',
    maxRetries: 0,
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    ...options,
  })
}

describe('openAI stream completion compatibility', () => {
  it.each(['\n', '\r\n'])('preserves incremental Unicode text and usage with a byte-split %j terminator', async (newline) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start: value => controller = value })
    const response = stream(body)
    const deltas: string[] = []
    controller.enqueue(encoder.encode(textDelta('你好')))
    for await (const event of response) {
      if (event.type === 'text_delta') {
        deltas.push(event.delta)
        if (deltas.length === 1) {
          const remaining = `${textDelta('，世界') + frame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}data: [DONE]\n\n`
          for (const byte of encoder.encode(remaining.replaceAll('\n', newline)))
            controller.enqueue(new Uint8Array([byte]))
          controller.close()
        }
      }
      expect(event.type).not.toBe('error')
    }
    const result = await response.result()
    expect(deltas).toEqual(['你好', '，世界'])
    expect(result).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: '你好，世界' }], usage: { input: 7, output: 4, totalTokens: 11 } })
    expect(result.rawStopReason).toBeUndefined()
    expect(result.diagnostics).toEqual([{ type: INFERRED_STREAM_COMPLETION, timestamp: expect.any(Number) }])

    const records: unknown[] = []
    const observer = new PiApplicationObserver({ runId: 'run-fixture', report: record => records.push(applicationDiagnosticSchema.parse(record)) })
    observer.handle({ type: 'turn_start' })
    observer.handle({ type: 'turn_end', message: result, toolResults: [] })
    expect(records).toContainEqual(expect.objectContaining({ event: INFERRED_STREAM_COMPLETION, level: 'warn', runId: 'run-fixture', turnId: 'run-fixture:1' }))
    expect(JSON.stringify(records)).not.toContain('你好')
  })

  it.each([
    ['content that mentions the sentinel', textDelta('[DONE]')],
    ['incomplete sentinel', `${textDelta('partial')}data: [DONE]`],
    ['sentinel comment', `${textDelta('partial')}: data: [DONE]\n\n`],
    ['empty response', 'data: [DONE]\n\n'],
    ['provider error', `${textDelta('partial')}${frame({ error: { message: 'fixture upstream failure' } })}data: [DONE]\n\n`],
    ['upstream error with the same wording', `${textDelta('partial')}${frame({ error: { message: 'Stream ended without finish_reason' } })}data: [DONE]\n\n`],
    ['malformed JSON', `${textDelta('partial')}data: {invalid}\n\ndata: [DONE]\n\n`],
  ])('does not recover %s', async (_name, body) => {
    const result = await stream(body).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toBeTruthy()
    expect(result.diagnostics).toBeUndefined()
  })

  it.each(['disconnect', 'cancel'] as const)('preserves %s after receiving text', async (action) => {
    const abort = new AbortController()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const response = stream(new ReadableStream<Uint8Array>({ start: value => controller = value }), { signal: abort.signal })
    controller.enqueue(encoder.encode(textDelta('partial')))
    for await (const event of response) {
      if (event.type === 'text_delta') {
        if (action === 'cancel') {
          abort.abort()
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
        else {
          controller.error(new Error('fixture connection closed'))
        }
      }
    }
    const result = await response.result()
    expect(result.stopReason).toBe(action === 'cancel' ? 'aborted' : 'error')
    expect(result.diagnostics).toBeUndefined()
  })

  it('keeps completion evidence isolated between concurrent requests', async () => {
    const results = await Promise.all([
      stream(`${textDelta('complete')}data: [DONE]\n\n`).result(),
      stream(textDelta('partial')).result(),
    ])
    expect(results.map(result => result.stopReason)).toEqual(['stop', 'error'])
  })

  it('leaves the existing provider-specific compatibility policy intact', async () => {
    const result = await provider.stream({ ...model, compat: { supportsFinishReason: false } }, context, {
      apiKey: 'fixture-key',
      fetch: async () => new Response(textDelta('accepted'), { headers: { 'content-type': 'text/event-stream' } }),
    }).result()
    expect(result.stopReason).toBe('stop')
    expect(result.diagnostics).toBeUndefined()
  })
})
