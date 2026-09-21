import type { Api, AssistantMessageEvent, Model, Provider, TranscriptContext } from '@earendil-works/pi-ai'
import { lazyStream } from '@earendil-works/pi-ai'

interface BuiltinProviderInstanceOptions {
  id: string
  name: string
  source: Provider
  getCatalogModels: () => readonly Model<Api>[]
}

export function createBuiltinProviderInstance(options: BuiltinProviderInstanceOptions): Provider {
  const { id, name, source } = options
  const toSourceModel = <T extends Api>(model: Model<T>): Model<T> => ({ ...model, provider: source.id })
  const toInstanceModel = (model: Model<Api>): Model<Api> => ({ ...model, provider: id })
  const toSourceContext = (context: TranscriptContext): TranscriptContext => ({
    ...context,
    messages: context.messages.map((message) => {
      if (message.role !== 'assistant')
        return message
      if (message.provider === id)
        return { ...message, provider: source.id }
      if (message.provider === source.id)
        return { ...message, provider: `builtin-instance:${source.id}` }
      return message
    }),
  })
  const forward = (model: Model<Api>, stream: () => AsyncIterable<AssistantMessageEvent>) => lazyStream(
    model,
    async () => mapEvents(stream(), id),
  )
  return {
    id,
    name,
    baseUrl: source.baseUrl,
    headers: source.headers,
    auth: source.auth,
    getModels: () => (source.refreshModels ? source.getModels() : options.getCatalogModels()).map(toInstanceModel),
    filterModels: source.filterModels
      ? (models, credential) => source.filterModels!(models.map(toSourceModel), credential).map(toInstanceModel)
      : undefined,
    refreshModels: source.refreshModels
      ? context => source.refreshModels!({
        ...context,
        stored: context.stored && { ...context.stored, models: context.stored.models.map(toSourceModel) },
        publish: publication => context.publish({
          ...publication,
          persist: publication.persist && {
            ...publication.persist,
            models: publication.persist.models.map(toInstanceModel),
          },
        }),
      })
      : undefined,
    stream: (model, context, streamOptions) => forward(model, () => source.stream(toSourceModel(model), toSourceContext(context), streamOptions)),
    streamSimple: (model, context, streamOptions) => forward(model, () => source.streamSimple(toSourceModel(model), toSourceContext(context), streamOptions)),
    fetchDeferred: source.fetchDeferred
      ? (model, handle, fetchOptions) => forward(model, () => source.fetchDeferred!(toSourceModel(model), handle, fetchOptions))
      : undefined,
    cancelDeferred: source.cancelDeferred
      ? (model, handle, cancelOptions) => source.cancelDeferred!(toSourceModel(model), handle, cancelOptions)
      : undefined,
  }
}

async function* mapEvents(stream: AsyncIterable<AssistantMessageEvent>, provider: string): AsyncIterable<AssistantMessageEvent> {
  for await (const event of stream) {
    if (event.type === 'done')
      yield { ...event, message: { ...event.message, provider } }
    else if (event.type === 'error')
      yield { ...event, error: { ...event.error, provider } }
    else
      yield { ...event, partial: { ...event.partial, provider } }
  }
}
