import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ProviderRequestDiagnostic } from '../../../shared/diagnostics/providerRequestDiagnostic'
import { lazyStream } from '@earendil-works/pi-ai'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { diagnosticResponseType, diagnosticTransportCode } from '../../../shared/diagnostics/providerRequestDiagnostic'
import { diagnosticContext } from '../diagnostics/diagnosticContext'

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
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!receivedDone) {
          const text = tail + decoder.decode(chunk, { stream: true })
          receivedDone = /\r?\n\r?\ndata: ?\[DONE\]\r?\n\r?\n/.test(text)
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
    try {
      const source = start({ ...options, fetch, onResponse: async (response, responseModel) => {
        observedResponse(response.status, new Headers(response.headers))
        await options?.onResponse?.(response, responseModel)
      } } as T)
      for await (let event of source) {
        if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta')
          evidence.contentEvents!++
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
        if (event.type === 'done' || event.type === 'error') {
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
      recordEnd(true, options?.signal?.aborted)
      throw error
    }
    finally {
      recordEnd(true, options?.signal?.aborted)
    }
  }
}
