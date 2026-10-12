import type { AutomationModelTarget } from '../../../shared/automation'
import type { BuddyConfigurationSnapshot } from '../buddies/BuddyExecutionDefinition'
import type { ProviderExecutionModelResolver } from '../providers/ProviderExecutionModelResolver'
import type { ProviderService } from '../providers/ProviderService'
import type { ResolvedAutomationModel } from './AgentTaskAutomationAction'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

export interface AutomationModelSelectionDependencies {
  defaults: Pick<ProviderService, 'getDefaultModel'>
  models: Pick<ProviderExecutionModelResolver, 'resolveAvailable' | 'getServiceTiers'>
}

export async function resolveAutomationModelSelection(
  dependencies: AutomationModelSelectionDependencies,
  target: AutomationModelTarget,
  actorModel: BuddyConfigurationSnapshot['settings']['model'] = null,
): Promise<ResolvedAutomationModel | null> {
  const selected = target.mode === 'pinned'
    ? {
        modelId: target.modelId,
        providerId: target.providerId,
        reasoning: target.reasoning,
      }
    : actorModel ?? await dependencies.defaults.getDefaultModel()
  if (!selected)
    return null
  try {
    const model = await dependencies.models.resolveAvailable({
      contextWindow: null,
      maxTokens: null,
      modelId: selected.modelId,
      providerId: selected.providerId,
    })
    if (
      selected.reasoning !== null
      && !getSupportedThinkingLevels(model).includes(selected.reasoning)
    ) {
      return null
    }
    const serviceTier = 'serviceTier' in selected ? selected.serviceTier : null
    if (serviceTier !== null && !dependencies.models.getServiceTiers({
      api: model.api,
      modelId: model.id,
      providerId: selected.providerId,
    }).some(option => option.id === serviceTier)) {
      return null
    }
    return {
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      modelId: selected.modelId,
      providerId: selected.providerId,
      reasoning: selected.reasoning,
      serviceTier,
    }
  }
  catch {
    return null
  }
}
