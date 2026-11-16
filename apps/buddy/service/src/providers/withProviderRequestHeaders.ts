import type { Provider, ProviderRequestOptions } from '@earendil-works/pi-ai'
import type { ProviderRequestHeaders } from './ProviderRequestHeaders'
import { lazyStream } from '@earendil-works/pi-ai'

export function withProviderRequestHeaders(provider: Provider, headers: ProviderRequestHeaders, authentication?: 'api_key' | 'none'): Provider {
  async function prepare<T extends Pick<ProviderRequestOptions, 'headers' | 'apiKey'>>(options?: T): Promise<T> {
    const unauthenticated = authentication === 'none'
    const apiKey = unauthenticated ? undefined : options?.apiKey
    const defaults = unauthenticated ? { authorization: null, ...options?.headers } : options?.headers
    const resolvedHeaders = headers.resolve(provider.id, defaults, apiKey)
    return {
      ...options,
      apiKey: unauthenticated ? 'unused' : apiKey,
      headers: resolvedHeaders,
    } as T
  }
  return {
    ...provider,
    stream: (model, context, options) => lazyStream(model, async () => provider.stream(model, context, await prepare(options))),
    streamSimple: (model, context, options) => lazyStream(model, async () => provider.streamSimple(model, context, await prepare(options))),
    fetchDeferred: provider.fetchDeferred
      ? (model, handle, options) => lazyStream(model, async () => provider.fetchDeferred!(model, handle, await prepare(options)))
      : undefined,
    cancelDeferred: provider.cancelDeferred
      ? async (model, handle, options) => provider.cancelDeferred!(model, handle, await prepare(options))
      : undefined,
    generateImages: provider.generateImages
      ? async (model, context, options) => provider.generateImages!(model, context, await prepare(options))
      : undefined,
    classify: provider.classify
      ? async (model, context, options) => provider.classify!(model, context, await prepare(options))
      : undefined,
  }
}
