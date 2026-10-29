import type { SpeechProvider } from '../../shared/speech/speechApi'
import type { SpeechBackend } from './SpeechBackend'

export function combineSpeechBackends(backends: SpeechBackend[]): SpeechBackend {
  const resolve = async (provider: SpeechProvider) => {
    for (const backend of backends) {
      if ((await backend.list().catch(() => [])).some(item => item.id === provider.id && item.revision === provider.revision))
        return backend
    }
    throw new Error('SPEECH_PROVIDER_UNAVAILABLE')
  }
  return {
    voices: async provider => (await resolve(provider)).voices?.(provider) ?? [],
    list: async () => (await Promise.all(backends.map(backend => backend.list().catch(() => [])))).flat(),
    onChanged: (listener) => {
      const releases = backends.map(backend => backend.onChanged?.(listener))
      return () => releases.forEach(release => release?.())
    },
    prepare: async provider => (await resolve(provider)).prepare(provider),
    invoke: async (provider, input) => (await resolve(provider)).invoke(provider, input),
  }
}
