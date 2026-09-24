import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ProviderRequestHeaders } from './ProviderRequestHeaders'
import type { ProviderModelRuntime } from './ProviderService'
import { withProviderRequestHeaders } from './withProviderRequestHeaders'
import { withProviderStream } from './withProviderStream'

export function createProviderModelRuntime(runtime: ModelRuntime, headers: ProviderRequestHeaders, record?: ApplicationDiagnosticReporter): ProviderModelRuntime {
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
    registerProvider: (id, config) => {
      runtime.registerProvider(id, config)
      const provider = runtime.getProvider(id)
      if (provider)
        runtime.registerNativeProvider(withProviderRequestHeaders(withProviderStream(provider, record), headers))
    },
  }
}
