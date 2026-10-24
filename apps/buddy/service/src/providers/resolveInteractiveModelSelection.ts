import type {
  BuddyServiceTier,
  BuddyThinkingLevel,
} from '../../../shared/conversation/modelSelection'
import type { ProviderExecutionModelResolver } from './ProviderExecutionModelResolver'
import type { ProviderService } from './ProviderService'
import { getModelFileInputMimeTypes, supportsModelToolCalls } from './modelCapabilities'
import {
  ProviderAuthenticationRequiredError,
  ProviderValidationError,
} from './ProviderFailure'

export interface InteractiveModelSelection {
  modelId: string
  providerId: string
  reasoning: BuddyThinkingLevel | null
  serviceTier: BuddyServiceTier | null
}

export interface ResolvedInteractiveModelSelection extends InteractiveModelSelection {
  api: string
  contextWindow: number
  input: Array<'text' | 'image'>
  fileInputMimeTypes: ReturnType<typeof getModelFileInputMimeTypes>
  maxTokens: number
  toolCall?: boolean
}

export interface RuntimeModelProvider extends Pick<ProviderService, 'getDefaultModel'> {
  executionModels: Pick<ProviderExecutionModelResolver, 'resolveAvailable' | 'getServiceTiers'>
}

export async function resolveInteractiveModelSelection(
  providers: RuntimeModelProvider,
  requested: InteractiveModelSelection | null,
): Promise<ResolvedInteractiveModelSelection> {
  const selected = requested ?? await providers.getDefaultModel()
  if (!selected)
    throw new ProviderAuthenticationRequiredError()
  const model = await providers.executionModels.resolveAvailable({
    contextWindow: null,
    maxTokens: null,
    modelId: selected.modelId,
    providerId: selected.providerId,
  })
  const serviceTier = requested?.serviceTier ?? null
  if (
    serviceTier !== null
    && !providers.executionModels.getServiceTiers({
      api: model.api,
      modelId: model.id,
      providerId: selected.providerId,
    }).some(option => option.id === serviceTier)
  ) {
    throw new ProviderValidationError()
  }
  return {
    ...selected,
    api: model.api,
    contextWindow: model.contextWindow,
    input: model.input,
    fileInputMimeTypes: getModelFileInputMimeTypes(model),
    maxTokens: model.maxTokens,
    toolCall: supportsModelToolCalls(model),
    serviceTier,
  }
}
