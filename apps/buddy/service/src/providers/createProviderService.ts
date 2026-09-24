import type { DatabaseSync } from 'node:sqlite'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ProviderRepository } from '../storage/providerRepository'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createProviderRepository } from '../storage/providerRepository'
import { AuthInteractionService } from './AuthInteractionService'
import { createProviderModelRuntime } from './createProviderModelRuntime'
import { HostCredentialStore } from './HostCredentialStore'
import { createProviderCredentialStatus } from './ProviderCredentialStatus'
import { clearAmbientProviderCredentials } from './providerEnvironment'
import { OpenAiCompatibleModelDiscovery } from './ProviderModelDiscovery'
import { ProviderRequestHeaders } from './ProviderRequestHeaders'
import { ProviderService } from './ProviderService'

export interface CreateProviderServiceOptions {
  agentDirectory: string
  database: DatabaseSync
  getActiveRuns?: () => ReadonlyArray<{ model: string, provider: string }>
  peer: RuntimeRpcPeerContract
  providers?: ProviderRepository
  record?: ApplicationDiagnosticReporter
}

export async function createProviderService(
  options: CreateProviderServiceOptions,
): Promise<ProviderService> {
  clearAmbientProviderCredentials(process.env)
  registerBunOAuthFlows()
  await mkdir(options.agentDirectory, { mode: 0o700, recursive: true })
  await chmod(options.agentDirectory, 0o700)
  const modelsPath = join(options.agentDirectory, 'models.json')
  const modelsStorePath = join(options.agentDirectory, 'models-store.json')
  await writeFile(modelsPath, '{}\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(modelsPath, 0o600)

  const credentials = new HostCredentialStore(options.peer)
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
    credentials,
    modelsPath,
    modelsStorePath,
  })
  const providers = options.providers ?? createProviderRepository(options.database)
  const requestHeaders = new ProviderRequestHeaders(providers.states)
  const providerRuntime = createProviderModelRuntime(modelRuntime, requestHeaders, options.record)
  for (const provider of builtinProviders())
    providerRuntime.registerNativeProvider(provider)
  const service = new ProviderService({
    authInteractions: new AuthInteractionService({
      notify: (method, params) => options.peer.notify(method, params),
      openExternal: async (url) => {
        await options.peer.request('host.openExternal', { url })
      },
    }),
    credentialStatus: createProviderCredentialStatus(credentials),
    getActiveRuns: options.getActiveRuns,
    modelDiscovery: new OpenAiCompatibleModelDiscovery({ credentials, requestHeaders, record: options.record }),
    modelRuntime: providerRuntime,
    requestHeaders,
    providers,
    snapshotPath: join(options.agentDirectory, 'models.dev.json'),
    sessionRuntime: modelRuntime,
  })
  await service.initializeProviders()
  return service
}
