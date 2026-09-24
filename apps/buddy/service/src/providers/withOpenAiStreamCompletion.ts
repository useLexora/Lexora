import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import { lazyStream } from '@earendil-works/pi-ai'

export const INFERRED_STREAM_COMPLETION = 'model.stream.completion_inferred'

export function withOpenAiStreamCompletion(provider: Provider): Provider {
  return {
    ...provider,
    stream: (model, context, options) => complete(model, options, next => provider.stream(model, context, next)),
    streamSimple: (model, context, options) => complete(model, options, next => provider.streamSimple(model, context, next)),
  }
}

function complete<T extends StreamOptions>(model: Model<Api>, options: T | undefined, start: (options?: T) => AssistantMessageEventStream): AssistantMessageEventStream {
  if (model.api !== 'openai-completions')
    return start(options)

  let receivedDone = false
  const request = options?.fetch ?? globalThis.fetch
  const fetch: typeof globalThis.fetch = async (input, init) => {
    receivedDone = false
    const response = await request(input, init)
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
      return response

    const decoder = new TextDecoder()
    let tail = '\n\n'
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!receivedDone) {
          const text = tail + decoder.decode(chunk, { stream: true })
          receivedDone = /\r?\n\r?\ndata: ?\[DONE\]\r?\n\r?\n/.test(text)
          tail = text.slice(-32)
        }
        controller.enqueue(chunk)
      },
    }))
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  return lazyStream(model, async () => finish(start({ ...options, fetch } as T)))

  async function* finish(source: AsyncIterable<AssistantMessageEvent>): AsyncIterable<AssistantMessageEvent> {
    let textCompleted = false
    for await (const event of source) {
      if (event.type === 'text_end' && event.content.trim())
        textCompleted = true
      if (
        event.type === 'error'
        && event.error.errorMessage === 'Stream ended without finish_reason'
        && receivedDone
        && textCompleted
        && !options?.signal?.aborted
        && !event.error.content.some(block => block.type === 'toolCall')
      ) {
        yield {
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
      else {
        yield event
      }
    }
  }
}
