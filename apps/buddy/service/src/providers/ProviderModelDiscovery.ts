import type { Credential } from '@earendil-works/pi-ai'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ProviderRequestDiagnostic } from '../../../shared/diagnostics/providerRequestDiagnostic'
import type { ProviderRequestHeaders } from './ProviderRequestHeaders'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { diagnosticResponseType, diagnosticTransportCode } from '../../../shared/diagnostics/providerRequestDiagnostic'
import { diagnosticContext } from '../diagnostics/diagnosticContext'
import {
  ProviderAuthenticationRequiredError,
  ProviderModelSyncError,
  ProviderModelSyncUnsupportedError,
} from './ProviderFailure'

export interface ProviderModelDefinition {
  readonly id: string
  readonly name?: string
}

export interface ProviderModelDiscoveryInput {
  readonly api: string
  readonly baseUrl: string
  readonly providerId: string
}

export interface ProviderModelDiscovery {
  discover: (
    input: ProviderModelDiscoveryInput,
  ) => Promise<readonly ProviderModelDefinition[]>
  supports: (api: string) => boolean
}

export interface OpenAiCompatibleModelDiscoveryOptions {
  readonly credentials: {
    read: (providerId: string) => Promise<Credential | undefined>
  }
  readonly request?: typeof fetch
  readonly requestHeaders?: ProviderRequestHeaders
  readonly record?: ApplicationDiagnosticReporter
}

export class OpenAiCompatibleModelDiscovery implements ProviderModelDiscovery {
  readonly #credentials: OpenAiCompatibleModelDiscoveryOptions['credentials']
  readonly #request: typeof fetch
  readonly #requestHeaders?: ProviderRequestHeaders
  readonly #record: ApplicationDiagnosticReporter

  constructor(options: OpenAiCompatibleModelDiscoveryOptions) {
    this.#credentials = options.credentials
    this.#request = options.request ?? fetch
    this.#requestHeaders = options.requestHeaders
    this.#record = safeDiagnosticReporter(options.record)
  }

  supports(api: string): boolean {
    return api === 'openai-completions' || api === 'openai-responses'
  }

  async discover(
    input: ProviderModelDiscoveryInput,
  ): Promise<readonly ProviderModelDefinition[]> {
    if (!this.supports(input.api))
      throw new ProviderModelSyncUnsupportedError()
    const credential = await this.#credentials.read(input.providerId)
    if (credential?.type !== 'api_key' || !credential.key)
      throw new ProviderAuthenticationRequiredError()

    const context = { ...diagnosticContext.getStore(), providerId: input.providerId, requestId: crypto.randomUUID(), component: 'runtime.providers' }
    const startedAt = performance.now()
    const evidence: ProviderRequestDiagnostic = { operation: 'models', api: input.api === 'openai-responses' ? 'openai-responses' : 'openai-completions', responseObserved: false }
    let failureStage: ProviderRequestDiagnostic['failureStage'] = 'request'
    this.#record({ ...context, event: 'provider.request.started', level: 'info' })
    try {
      const defaults = { Authorization: `Bearer ${credential.key}` }
      const resolved = await this.#requestHeaders?.resolve(input.providerId, defaults, credential.key) ?? defaults
      const headers = new Headers()
      for (const [name, value] of Object.entries(resolved)) {
        if (value !== null)
          headers.set(name, value)
      }
      const baseUrl = input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`
      const response = await this.#request(new URL('models', baseUrl), {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
      evidence.responseObserved = true
      evidence.responseMs = Math.round(performance.now() - startedAt)
      evidence.status = response.status
      evidence.responseType = diagnosticResponseType(response.headers.get('content-type'))
      failureStage = 'http'
      if (!response.ok)
        throw new ProviderModelSyncError()
      failureStage = 'decode'
      const body: unknown = await response.json()
      failureStage = 'schema'
      const models = parseModelDefinitions(body)
      this.#record({ ...context, event: 'provider.request.completed', level: 'info', durationMs: Math.round(performance.now() - startedAt), count: models.length, providerRequest: evidence })
      return models
    }
    catch (error) {
      evidence.failureStage = failureStage
      if (failureStage === 'request')
        evidence.transportCode = diagnosticTransportCode(error)
      this.#record({ ...context, event: 'provider.request.failed', level: 'error', errorCode: 'MODEL_SYNC_FAILED', durationMs: Math.round(performance.now() - startedAt), providerRequest: evidence })
      if (error instanceof ProviderModelSyncError)
        throw error
      throw new ProviderModelSyncError()
    }
  }
}

function parseModelDefinitions(value: unknown): readonly ProviderModelDefinition[] {
  if (!isRecord(value) || !Array.isArray(value.data))
    throw new ProviderModelSyncError()
  return value.data.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim())
      throw new ProviderModelSyncError()
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    return {
      id: item.id.trim(),
      ...(name ? { name } : {}),
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
