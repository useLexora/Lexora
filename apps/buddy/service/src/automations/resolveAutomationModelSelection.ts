import type { AutomationModelTarget } from '../../../shared/automation'
import type { ProviderExecutionModelResolver } from '../providers/ProviderExecutionModelResolver'
import type { ProviderService } from '../providers/ProviderService'
import type { ResolvedAutomationModel } from './AgentTaskAutomationAction'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

export interface AutomationModelSelectionDependencies {
  defaults: Pick<ProviderService, 'getDefaultModel'>
  models: Pick<ProviderExecutionModelResolver, 'resolveAvailable'>
}

export async function resolveAutomationModelSelection(
  dependencies: AutomationModelSelectionDependencies,
  target: AutomationModelTarget,
): Promise<ResolvedAutomationModel | null> {
  const selected = target.mode === 'pinned'
    ? {
        modelId: target.modelId,
        providerId: target.providerId,
        reasoning: target.reasoning,
      }
    : await dependencies.defaults.getDefaultModel()
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
    return {
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      modelId: selected.modelId,
      providerId: selected.providerId,
      reasoning: selected.reasoning,
    }
  }
  catch {
    return null
  }
}
