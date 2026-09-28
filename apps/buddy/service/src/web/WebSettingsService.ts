import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { WebSettings, WebSettingsSnapshot } from '../../../shared/network/webProtocol'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { WorkspaceRepository } from '../storage/workspaceRepository'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { webRpc } from '../../../shared/network/webApi'
import { DEFAULT_WEB_SETTINGS, webCredentialInputSchema, webSearchSourceSchema, webSettingsSchema } from '../../../shared/network/webProtocol'
import { credentialMutationResultSchema, credentialReadResultSchema } from '../../../shared/runtime/credentialProtocol'
import { HostCredentialStoreError } from '../providers/HostCredentialStore'
import { BuddyServiceError, parse, registerRuntimeRequest } from '../rpc/runtimeRequest'

const SETTINGS_KEY = 'buddy.web'
const storedSettingsSchema = webSettingsSchema.extend({
  search: webSearchSourceSchema.array().refine(sources => new Set(sources.map(source => source.provider)).size === sources.length),
})

export class WebSettingsService {
  readonly #changes = new Emitter<WebSettingsChange>(() => console.error('WEB_SETTINGS_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #configured: boolean | null = null
  #disposing: Promise<void> | undefined
  readonly repository: Pick<WorkspaceRepository, 'get' | 'set'>
  readonly peer: Pick<RuntimeRpcPeerContract, 'request'>
  #mutation: Promise<unknown> = Promise.resolve()

  constructor(
    repository: Pick<WorkspaceRepository, 'get' | 'set'>,
    peer: Pick<RuntimeRpcPeerContract, 'request'>,
  ) {
    this.repository = repository
    this.peer = peer
  }

  get(): WebSettings {
    const settings = storedSettingsSchema.parse(this.repository.get(SETTINGS_KEY) ?? DEFAULT_WEB_SETTINGS)
    const providers = new Set(settings.search.map(source => source.provider))
    settings.search.push(...DEFAULT_WEB_SETTINGS.search.filter(source => !providers.has(source.provider)).map(source => ({ ...source })))
    return settings
  }

  async snapshot(): Promise<WebSettingsSnapshot> {
    return { settings: this.get(), tavilyKeyConfigured: Boolean(await this.getTavilyKey()) }
  }

  get state() { return copyEventSnapshot({ revision: this.#revision, settings: this.get(), tavilyKeyConfigured: this.#configured }) }

  async getTavilyKey(): Promise<string | null> {
    const revision = this.#revision
    const result = credentialReadResultSchema.parse(await this.peer.request('host.secrets.read', {
      namespace: 'web',
      id: 'tavily',
    }))
    if (!result.ok)
      throw new HostCredentialStoreError(result.error.code)
    const key = typeof result.value === 'string' && result.value ? result.value : null
    if (!this.#disposing && revision === this.#revision && this.#configured !== Boolean(key)) {
      this.#configured = Boolean(key)
      this.#publish('credential-observed', randomUUID())
    }
    return key
  }

  save(input: unknown): Promise<WebSettingsSnapshot> {
    const settings = parse(webSettingsSchema, input)
    return this.#mutate(async () => {
      const tavilyKeyConfigured = Boolean(await this.getTavilyKey())
      if (!tavilyKeyConfigured && (settings.fetch.remote || settings.search.some(source => source.provider === 'tavily' && source.enabled)))
        throw new BuddyServiceError('VALIDATION_FAILED')
      this.#commitSettings(settings, randomUUID())
      return { settings, tavilyKeyConfigured }
    })
  }

  saveCredential(input: unknown): Promise<WebSettingsSnapshot> {
    const { key } = parse(webCredentialInputSchema, input)
    return this.#mutate(async () => {
      const operationId = randomUUID()
      const previouslyConfigured = Boolean(await this.getTavilyKey())
      if (key === null || !previouslyConfigured) {
        const settings = this.get()
        settings.search = settings.search.map(source => source.provider === 'tavily' ? { ...source, enabled: false } : source)
        settings.fetch.remote = false
        this.#commitSettings(settings, operationId)
      }
      try {
        const result = credentialMutationResultSchema.parse(await this.peer.request(
          key === null ? 'host.secrets.delete' : 'host.secrets.write',
          { namespace: 'web', id: 'tavily', ...(key === null ? {} : { value: key }) },
        ))
        if (!result.ok)
          throw new HostCredentialStoreError(result.error.code)
        this.#configured = key !== null
        this.#publish('credential-committed', operationId)
      }
      catch (error) {
        this.#configured = null
        this.#publish('credential-failed', operationId)
        throw error
      }
      return { settings: this.get(), tavilyKeyConfigured: key !== null }
    })
  }

  #mutate(operation: () => Promise<WebSettingsSnapshot>): Promise<WebSettingsSnapshot> {
    if (this.#disposing)
      return Promise.reject(new Error('WEB_SETTINGS_STOPPED'))
    const result = this.#mutation.then(operation)
    this.#mutation = result.catch(() => {})
    return result
  }

  #commitSettings(settings: WebSettings, operationId: string): void {
    if (JSON.stringify(this.repository.get(SETTINGS_KEY)) === JSON.stringify(settings))
      return
    this.repository.set(SETTINGS_KEY, settings, new Date().toISOString())
    this.#publish('settings-committed', operationId)
  }

  #publish(kind: WebSettingsChange['kind'], operationId: string): void {
    this.#changes.fire(copyEventSnapshot({ kind, operationId, revision: ++this.#revision, settings: this.get(), tavilyKeyConfigured: this.#configured }))
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#mutation.then(() => this.#changes.dispose())
    return this.#disposing
  }
}

export interface WebSettingsChange {
  readonly kind: 'settings-committed' | 'credential-committed' | 'credential-failed' | 'credential-observed'
  readonly operationId: string
  readonly revision: number
  readonly settings: EventSnapshot<WebSettings>
  readonly tavilyKeyConfigured: boolean | null
}

export function registerWebSettingsRpc(rpc: Pick<RuntimeRpcPeerContract, 'onRequest'>, service: WebSettingsService): () => void {
  const disposers = [
    registerRuntimeRequest(rpc, webRpc.settings, () => service.snapshot()),
    registerRuntimeRequest(rpc, webRpc.saveSettings, input => service.save(input)),
    registerRuntimeRequest(rpc, webRpc.saveCredential, input => service.saveCredential(input)),
  ]
  return () => disposers.forEach(dispose => dispose())
}
