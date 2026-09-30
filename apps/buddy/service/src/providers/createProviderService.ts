import type { DatabaseSync } from 'node:sqlite'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ProviderRepository } from '../storage/providerRepository'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { providerNotifications } from '../../../shared/providers/providerApi'
import { createProviderRepository } from '../storage/providerRepository'
import { createWorkspaceRepository } from '../storage/workspaceRepository'
import { AuthInteractionService } from './AuthInteractionService'
import { createProviderLoginOptions } from './createProviderLoginOptions'
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
  const authInteractions = new AuthInteractionService({ openExternal: async (url) => {
    await options.peer.request('host.openExternal', { url })
  } })
  authInteractions.onDidChallenge(challenge => options.peer.notify(providerNotifications.authChallenge.method, challenge))
  authInteractions.onDidChange(change => options.record?.({ event: `provider.auth.${change.kind.replaceAll('-', '_')}`, level: 'info', operationId: change.loginId, count: change.kind === 'challenge-opened' ? 1 : 0 }))
  const service = new ProviderService({
    authInteractions,
    loginOptions: createProviderLoginOptions(createWorkspaceRepository(options.database)),
    credentials,
    credentialStatus: createProviderCredentialStatus(credentials),
    getActiveRuns: options.getActiveRuns,
    modelDiscovery: new OpenAiCompatibleModelDiscovery({ credentials, requestHeaders, record: options.record }),
    modelRuntime: providerRuntime,
    requestHeaders,
    providers,
    snapshotPath: join(options.agentDirectory, 'models.dev.json'),
    sessionRuntime: modelRuntime,
  })
  service.onDidCommit(event => options.peer.notify(providerNotifications.changed.method, { source: 'catalog', revision: event.revision }))
  service.onDidChangeMetadata((event) => {
    if (event.kind === 'refresh-completed' || event.kind === 'refresh-failed' || event.kind === 'accepted')
      options.peer.notify(providerNotifications.changed.method, { source: 'metadata', revision: event.revision })
  })
  service.onDidChangeCredential((event) => {
    if (event.kind === 'observation' || event.kind === 'store-availability')
      options.peer.notify(providerNotifications.changed.method, { source: 'credentials', revision: event.kind === 'observation' ? event.current.revision : event.revision })
  })
  service.onDidOperate(event => options.record?.({ event: `provider.operation.${event.stage}`, level: event.stage === 'failed' ? 'warn' : 'info', operationId: event.operationId }))
  service.onDidCommit(event => options.record?.({ event: 'provider.state.committed', level: 'info', operationId: event.commitId, revision: event.revision, count: event.providers.length + event.models.length }))
  service.onDidApplyCatalog(event => options.record?.({ event: `provider.catalog.${event.stage}`, level: event.stage === 'failed' ? 'warn' : 'info', operationId: event.operationId, revision: event.revision }))
  service.onDidChangeMetadata(event => options.record?.({ event: `provider.metadata.${event.kind.replaceAll('-', '_')}`, level: event.kind.endsWith('failed') ? 'warn' : 'info', operationId: event.operationId, revision: event.catalogRevision, count: event.modelCount }))
  service.onDidChangeCredential((event) => {
    if (event.kind === 'observation')
      options.record?.({ event: `provider.credential.${event.current.presence}`, level: event.current.presence === 'unknown' ? 'warn' : 'info', revision: event.current.revision })
    else if (event.kind === 'store-availability')
      options.record?.({ event: `provider.credential_store.${event.status}`, level: event.status === 'unknown' ? 'warn' : 'info', revision: event.revision })
    else
      options.record?.({ event: `provider.credential.${event.kind.replaceAll('-', '_')}`, level: 'info', operationId: event.operationId })
  })
  try {
    await service.initializeProviders()
  }
  catch (error) {
    try {
      await service.dispose()
    }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Provider initialization failed') }
    throw error
  }
  return service
}
