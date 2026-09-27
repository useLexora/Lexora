import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { BuddyServiceTierOption } from '../../../shared/conversation/modelSelection'
import type { BuiltinProviderConfigRepository } from '../storage/builtinProviderConfigRepository'
import type { ProviderStateRepository } from '../storage/providerStateRepository'
import type { ModelMetadataCatalog } from './ModelsDevCatalog'
import type { ProviderCredentialStatus } from './ProviderCredentialStatus'
import type { ProviderModelCatalog } from './ProviderModelCatalog'
import { BUDDY_FAST_SERVICE_TIER } from '../../../shared/conversation/modelSelection'
import {
  ProviderAuthenticationRequiredError,
  ProviderUnavailableError,
  ProviderValidationError,
} from './ProviderFailure'
import { modelParametersOverrideSchema } from './providerSchemas'

export interface ProviderExecutionModelInput {
  contextWindow: number | null
  maxTokens: number | null
  modelId: string
  providerId: string
}

export interface ResolvedProviderSessionModel {
  model: Model<Api>
  runtime: ModelRuntime
}

export interface ProviderExecutionModelResolverOptions {
  builtins: Pick<BuiltinProviderConfigRepository, 'findById'>
  credentialStatus: ProviderCredentialStatus
  metadata: Pick<ModelMetadataCatalog, 'getModels'>
  modelCatalog: Pick<
    ProviderModelCatalog,
    'isEnabledAvailable' | 'resolve'
  >
  sessionRuntime?: ModelRuntime
  states: Pick<ProviderStateRepository, 'findByProviderId'>
}

export class ProviderExecutionModelResolver {
  readonly #builtins: ProviderExecutionModelResolverOptions['builtins']
  readonly #credentialStatus: ProviderCredentialStatus
  readonly #metadata: ProviderExecutionModelResolverOptions['metadata']
  readonly #modelCatalog: ProviderExecutionModelResolverOptions['modelCatalog']
  readonly #sessionRuntime?: ModelRuntime
  readonly #states: ProviderExecutionModelResolverOptions['states']

  constructor(options: ProviderExecutionModelResolverOptions) {
    this.#builtins = options.builtins
    this.#credentialStatus = options.credentialStatus
    this.#metadata = options.metadata
    this.#modelCatalog = options.modelCatalog
    this.#sessionRuntime = options.sessionRuntime
    this.#states = options.states
  }

  resolve(input: ProviderExecutionModelInput): Model<Api> {
    const model = this.#modelCatalog.resolve(input.providerId, input.modelId)
    if (input.contextWindow === null && input.maxTokens === null)
      return model
    const parameters = modelParametersOverrideSchema.safeParse({
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
    })
    if (!parameters.success)
      throw new ProviderValidationError()
    return { ...model, ...parameters.data }
  }

  async resolveAvailable(input: ProviderExecutionModelInput): Promise<Model<Api>> {
    const state = this.#states.findByProviderId(input.providerId)
    if (!state?.enabled || !this.#modelCatalog.isEnabledAvailable(
      input.providerId,
      input.modelId,
    )) {
      throw new ProviderUnavailableError()
    }
    const model = this.resolve(input)
    const credentials = await this.#credentialStatus.listOrEmpty()
    if (!credentials.some(credential => credential.providerId === input.providerId))
      throw new ProviderAuthenticationRequiredError()
    return model
  }

  async resolveSession(input: ProviderExecutionModelInput): Promise<ResolvedProviderSessionModel> {
    return {
      model: await this.resolveAvailable(input),
      runtime: this.getRuntime(),
    }
  }

  getRuntime(): ModelRuntime {
    if (!this.#sessionRuntime)
      throw new ProviderUnavailableError()
    return this.#sessionRuntime
  }

  getServiceTiers(input: { api: string, modelId: string, providerId: string }): ReadonlyArray<BuddyServiceTierOption> {
    const providerId = this.resolveSourceProviderId(input.providerId)
    const supportsFast = (providerId === 'openai-codex' && input.api === 'openai-codex-responses')
      || (providerId === 'openai' && input.api === 'openai-responses'
        && this.#metadata.getModels('openai').some(model => model.id === input.modelId && model.fastMode))
    return supportsFast ? [{ displayName: 'Fast', id: BUDDY_FAST_SERVICE_TIER }] : []
  }

  resolveSourceProviderId(providerId: string): string {
    return this.#builtins.findById(providerId)?.builtinProviderId ?? providerId
  }
}
