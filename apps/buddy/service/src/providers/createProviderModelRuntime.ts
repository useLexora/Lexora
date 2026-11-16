import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ProviderRequestHeaders } from './ProviderRequestHeaders'
import type { ProviderModelRuntime } from './ProviderService'
import { withProviderRequestContext } from './withProviderRequestContext'
import { withProviderRequestHeaders } from './withProviderRequestHeaders'
import { withProviderStream } from './withProviderStream'

export function createProviderModelRuntime(runtime: ModelRuntime, headers: ProviderRequestHeaders, record?: ApplicationDiagnosticReporter): ProviderModelRuntime {
  const refresh = runtime.refresh.bind(runtime)
  let refreshing = Promise.resolve()
  // Pi registration also starts refreshes; serialize them with explicit cache restoration and discovery.
  runtime.refresh = (options) => {
    const result = refreshing.then(() => refresh(options))
    refreshing = result.then(() => {}, () => {})
    return result
  }
  return {
    getModels: runtime.getModels.bind(runtime),
    getProvider: runtime.getProvider.bind(runtime),
    getProviders: runtime.getProviders.bind(runtime),
    getAvailable: runtime.getAvailable.bind(runtime),
    login: runtime.login.bind(runtime),
    logout: runtime.logout.bind(runtime),
    refresh: runtime.refresh.bind(runtime),
    unregisterProvider: runtime.unregisterProvider.bind(runtime),
    registerNativeProvider: provider => runtime.registerNativeProvider(withProviderRequestHeaders(withProviderStream(provider, record), headers)),
    registerProvider: (id, { authentication, ...config }) => {
      runtime.registerProvider(id, config)
      const provider = runtime.getProvider(id)
      if (provider) {
        const configured = authentication === 'none'
          ? {
              ...provider,
              auth: { apiKey: { ...provider.auth.apiKey, name: provider.name, check: undefined, resolve: async () => ({ auth: {}, source: 'explicitly unauthenticated' }) } },
            }
          : provider
        runtime.registerNativeProvider(withProviderRequestHeaders(withProviderStream(withProviderRequestContext(configured), record), headers, authentication))
      }
    },
  }
}
