import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ProviderRequestDiagnostic } from '../../../shared/diagnostics/providerRequestDiagnostic'
import { lazyStream } from '@earendil-works/pi-ai'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { diagnosticResponseType, diagnosticTransportCode } from '../../../shared/diagnostics/providerRequestDiagnostic'
import { diagnosticContext } from '../diagnostics/diagnosticContext'

export const MODEL_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000
export const INFERRED_STREAM_COMPLETION = 'model.stream.completion_inferred'

export function withProviderStream(provider: Provider, record?: ApplicationDiagnosticReporter): Provider {
  const report = safeDiagnosticReporter(record)
  return {
    ...provider,
    stream: (model, context, options) => complete(model, options, next => provider.stream(model, context, next), report),
    streamSimple: (model, context, options) => complete(model, options, next => provider.streamSimple(model, context, next), report),
  }
}

function complete<T extends StreamOptions>(model: Model<Api>, options: T | undefined, start: (options?: T) => AssistantMessageEventStream, report: ApplicationDiagnosticReporter): AssistantMessageEventStream {
  const context = { ...diagnosticContext.getStore(), providerId: model.provider, requestId: crypto.randomUUID(), component: 'runtime.providers' }
  const evidence: ProviderRequestDiagnostic = { operation: 'completion', api: model.api === 'openai-completions' ? 'openai-completions' : model.api === 'openai-responses' ? 'openai-responses' : 'other', responseObserved: false, responseCount: 0, contentEvents: 0, doneMarker: 'unknown', completion: 'unknown' }
  let startedAt = performance.now()
  let receivedDone = false
  let finished = false
  const observedResponse = (status: number, headers: Headers) => {
    evidence.responseObserved = true
    evidence.status = status
    evidence.responseType = diagnosticResponseType(headers.get('content-type'))
    evidence.responseMs = Math.round(performance.now() - startedAt)
  }
  const request = options?.fetch ?? globalThis.fetch
  const fetch: typeof globalThis.fetch = async (input, init) => {
    receivedDone = false
    Object.assign(evidence, { responseObserved: false, status: undefined, responseType: undefined, responseMs: undefined, doneMarker: 'unknown', failureStage: undefined, transportCode: undefined })
    let response: Response
    try {
      response = await request(input, init)
    }
    catch (error) {
      evidence.transportCode = diagnosticTransportCode(error)
      evidence.failureStage = 'request'
      throw error
    }
    evidence.responseCount!++
    observedResponse(response.status, response.headers)
    if (model.api !== 'openai-completions' || !response.ok || !response.body || evidence.responseType !== 'sse')
      return response

    evidence.doneMarker = 'not_observed'
    const decoder = new TextDecoder()
    let tail = '\n\n'
    let afterCarriageReturn = false
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!receivedDone) {
          const decoded = decoder.decode(chunk, { stream: true })
          const text = tail + (afterCarriageReturn && decoded.startsWith('\n') ? decoded.slice(1) : decoded).replace(/\r\n?/g, '\n')
          if (decoded.length)
            afterCarriageReturn = decoded.endsWith('\r')
          receivedDone = /\n\ndata: ?\[DONE\]\n\n/.test(text)
          if (receivedDone)
            evidence.doneMarker = 'observed'
          tail = text.slice(-32)
        }
        controller.enqueue(chunk)
      },
    }))
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  return lazyStream(model, async () => {
    startedAt = performance.now()
    report({ ...context, event: 'provider.request.started', level: 'info' })
    return finish()
  })

  function recordEnd(failed: boolean, cancelled = false): void {
    if (finished)
      return
    finished = true
    if (failed && !evidence.failureStage)
      evidence.failureStage = evidence.status && evidence.status >= 400 ? 'http' : evidence.doneMarker !== 'unknown' || evidence.contentEvents! > 0 ? 'stream' : 'unknown'
    report({ ...context, event: `provider.request.${cancelled ? 'cancelled' : failed ? 'failed' : 'completed'}`, level: cancelled ? 'info' : failed ? 'error' : evidence.completion === 'inferred' ? 'warn' : 'info', durationMs: Math.round(performance.now() - startedAt), providerRequest: { ...evidence } })
  }

  async function* finish(): AsyncIterable<AssistantMessageEvent> {
    let textCompleted = false
    let latest: AssistantMessage | undefined
    const deadline = new AbortController()
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let ended = false
    let rejectWait: ((reason: unknown) => void) | undefined
    const interrupt = () => rejectWait?.(signal.reason)
    signal.addEventListener('abort', interrupt, { once: true })
    const progress = () => {
      if (ended)
        return
      clearTimeout(timer)
      timer = setTimeout(() => {
        const error = new Error('Model stream timeout: no model progress for 300 seconds')
        deadline.abort(error)
      }, MODEL_PROGRESS_TIMEOUT_MS)
      timer.unref?.()
    }
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined
    try {
      const source = start({ ...options, fetch, signal, onProviderStreamEvent: async (event, responseModel) => {
        if (hasProviderProgress(event))
          progress()
        await options?.onProviderStreamEvent?.(event, responseModel)
      }, onResponse: async (response, responseModel) => {
        observedResponse(response.status, new Headers(response.headers))
        await options?.onResponse?.(response, responseModel)
      } } as T)
      iterator = source[Symbol.asyncIterator]()
      progress()
      while (true) {
        const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => {
          rejectWait = reject
          if (signal.aborted)
            reject(signal.reason)
          else
            void iterator!.next().then(resolve, reject)
        })
        if (next.done)
          break
        let event = next.value
        latest = event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial
        if (deadline.signal.aborted)
          throw deadline.signal.reason
        if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') {
          evidence.contentEvents!++
          if (event.delta.length)
            progress()
        }
        if (event.type === 'text_end' && event.content.trim())
          textCompleted = true
        if (
          event.type === 'error'
          && model.api === 'openai-completions'
          && event.error.errorMessage === 'Stream ended without finish_reason'
          && receivedDone
          && textCompleted
          && !options?.signal?.aborted
          && !event.error.content.some(block => block.type === 'toolCall')
        ) {
          event = {
            type: 'done',
            reason: 'stop',
            message: {
              ...event.error,
              stopReason: 'stop',
              errorMessage: undefined,
              diagnostics: [...event.error.diagnostics ?? [], { type: INFERRED_STREAM_COMPLETION, timestamp: Date.now() }],
            },
          }
        }
        if (event.type === 'done' && hasInvalidToolCallIds(event.message)) {
          event = {
            type: 'error',
            reason: 'error',
            error: { ...event.message, stopReason: 'error', errorMessage: 'Model returned duplicate or empty tool call IDs in one response. No tool calls from this response were executed.' },
          }
        }
        if (event.type === 'done' || event.type === 'error') {
          ended = true
          clearTimeout(timer)
          const message = event.type === 'done' ? event.message : event.error
          evidence.textCharacters = message.content.reduce((count, block) => count + (block.type === 'text' ? block.text.length : 0), 0)
          evidence.toolCalls = message.content.filter(block => block.type === 'toolCall').length
          evidence.completion = event.type === 'error'
            ? evidence.doneMarker !== 'unknown' || evidence.contentEvents! > 0 ? 'incomplete' : 'unknown'
            : message.diagnostics?.some(item => item.type === INFERRED_STREAM_COMPLETION) ? 'inferred' : 'sdk'
          recordEnd(event.type === 'error', options?.signal?.aborted)
        }
        yield event
      }
    }
    catch (error) {
      evidence.transportCode ??= diagnosticTransportCode(error)
      if (!latest && !signal.aborted) {
        recordEnd(true)
        throw error
      }
      ended = true
      clearTimeout(timer)
      evidence.completion = evidence.contentEvents! > 0 ? 'incomplete' : 'unknown'
      recordEnd(true, options?.signal?.aborted)
      const message: AssistantMessage = {
        ...latest ?? {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: [],
          usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
        },
        stopReason: options?.signal?.aborted ? 'aborted' : 'error',
        errorMessage: options?.signal?.aborted ? 'Request aborted' : error instanceof Error ? error.message : String(error),
      }
      yield { type: 'error', reason: options?.signal?.aborted ? 'aborted' : 'error', error: message }
    }
    finally {
      ended = true
      clearTimeout(timer)
      rejectWait = undefined
      signal.removeEventListener('abort', interrupt)
      void iterator?.return?.().catch(() => {})
      recordEnd(true, options?.signal?.aborted)
    }
  }
}

function hasProviderProgress(value: unknown): boolean {
  if (!value || typeof value !== 'object')
    return false
  const event = value as Record<string, unknown>
  if (typeof event.delta === 'string')
    return event.delta.length > 0
  const delta = event.delta && typeof event.delta === 'object' ? event.delta as Record<string, unknown> : undefined
  if (delta && ['text', 'thinking', 'signature', 'partial_json'].some(key => typeof delta[key] === 'string' && delta[key].length > 0))
    return true
  if (!Array.isArray(event.choices))
    return false
  return event.choices.some((choice) => {
    const delta = choice?.delta
    if (!delta || typeof delta !== 'object')
      return false
    return ['content', 'reasoning_content', 'reasoning', 'thinking'].some(key => typeof delta[key] === 'string' && delta[key].length > 0)
      || (Array.isArray(delta.tool_calls) && delta.tool_calls.some((call: { function?: { name?: string, arguments?: string } }) => Boolean(call.function?.name || call.function?.arguments)))
  })
}

function hasInvalidToolCallIds(message: AssistantMessage): boolean {
  const seen = new Set<string>()
  for (const block of message.content) {
    if (block.type !== 'toolCall')
      continue
    const id = message.api.endsWith('responses') ? block.id.split('|')[0]! : block.id
    if (!id.trim() || seen.has(id))
      return true
    seen.add(id)
  }
  return false
}
