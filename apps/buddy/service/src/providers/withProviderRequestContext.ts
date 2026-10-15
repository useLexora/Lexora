import type { Api, Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import { clampOpenAIPromptCacheKey } from '@earendil-works/pi-ai/api/openai-prompt-cache'

type SessionCompat = NonNullable<Model<Api>['compat']> & { supportsPromptCacheKey?: boolean, sendSessionAffinityHeaders?: boolean }

export function withProviderRequestContext(provider: Provider): Provider {
  function prepare<T extends StreamOptions>(model: Model<Api>, options?: T): T | undefined {
    const sessionId = options?.sessionId
    const compat = model.compat as SessionCompat | undefined
    if (!sessionId || !['openai-completions', 'anthropic-messages', 'openai-responses'].includes(model.api))
      return options
    const headers = { ...options?.headers }
    if (compat?.sendSessionAffinityHeaders !== false && !Object.keys(headers).some(name => name.toLowerCase() === 'x-session-affinity'))
      headers['x-session-affinity'] = sessionId
    const next = { ...options, headers } as T
    if (compat?.supportsPromptCacheKey !== true || options?.cacheRetention === 'none' || model.api !== 'openai-completions')
      return next
    const previous = options?.onPayload
    return {
      ...next,
      onPayload: async (payload: unknown, target: Model<Api>) => {
        const replacement = await previous?.(payload, target)
        const body = replacement === undefined ? payload : replacement
        if (!body || typeof body !== 'object' || Array.isArray(body) || ('prompt_cache_key' in body && body.prompt_cache_key !== undefined))
          return replacement
        return { ...body, prompt_cache_key: clampOpenAIPromptCacheKey(sessionId) }
      },
    }
  }
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, prepare(model, options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, prepare(model, options)),
  }
}
