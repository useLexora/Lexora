import type { AnyModel, Api, AssistantMessageEvent, Model, Provider, StreamOptions, TranscriptContext } from '@earendil-works/pi-ai'
import { isModelType, lazyStream } from '@earendil-works/pi-ai'

interface BuiltinProviderInstanceOptions {
  id: string
  name: string
  source: Provider
  getCatalogModels: () => readonly AnyModel[]
}

export function createBuiltinProviderInstance(options: BuiltinProviderInstanceOptions): Provider {
  const { id, name, source } = options
  const readSourceModels = () => source.getAllModels?.() ?? source.getModels()
  let models = readSourceModels()
  const toSourceModel = <T extends AnyModel>(model: T): T => ({ ...model, provider: source.id })
  const toInstanceModel = <T extends AnyModel>(model: T): T => ({ ...model, provider: id })
  const getAllModels = () => (source.refreshModels ? models : options.getCatalogModels()).map(toInstanceModel)
  const toSourceOptions = <T extends StreamOptions>(options?: T): T | undefined => options?.onProviderStreamEvent
    ? { ...options, onProviderStreamEvent: (data, model) => options.onProviderStreamEvent!(data, toInstanceModel(model)) }
    : options
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
    getModels: () => getAllModels().filter(model => isModelType(model, 'chat')),
    getAllModels,
    filterModels: source.filterModels
      ? (models, credential) => source.filterModels!(models.map(toSourceModel), credential).map(toInstanceModel)
      : undefined,
    filterAllModels: source.filterAllModels
      ? (models, credential) => source.filterAllModels!(models.map(toSourceModel), credential).map(toInstanceModel)
      : undefined,
    refreshModels: source.refreshModels
      ? context => source.refreshModels!({
        ...context,
        stored: context.stored && { ...context.stored, models: context.stored.models.map(toSourceModel) },
        publish: publication => context.publish({
          ...publication,
          update: () => {
            publication.update?.()
            models = readSourceModels()
          },
          persist: publication.persist && {
            ...publication.persist,
            models: publication.persist.models.map(toInstanceModel),
          },
        }),
      })
      : undefined,
    stream: (model, context, streamOptions) => forward(model, () => source.stream(toSourceModel(model), toSourceContext(context), toSourceOptions(streamOptions))),
    streamSimple: (model, context, streamOptions) => forward(model, () => source.streamSimple(toSourceModel(model), toSourceContext(context), toSourceOptions(streamOptions))),
    fetchDeferred: source.fetchDeferred
      ? (model, handle, fetchOptions) => forward(model, () => source.fetchDeferred!(toSourceModel(model), handle, fetchOptions))
      : undefined,
    cancelDeferred: source.cancelDeferred
      ? (model, handle, cancelOptions) => source.cancelDeferred!(toSourceModel(model), handle, cancelOptions)
      : undefined,
    generateImages: source.generateImages
      ? async (model, context, imageOptions) => ({ ...await source.generateImages!(toSourceModel(model), context, imageOptions), provider: id })
      : undefined,
    classify: source.classify
      ? async (model, context, classifierOptions) => ({ ...await source.classify!(toSourceModel(model), context, classifierOptions), provider: id })
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
