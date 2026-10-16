import type {
  AiModelCapability,
  AiModelIntentKey,
  AiModelRef,
  AiModelType,
} from '@haohaoxue/lexora-contracts'
import { AI_MODEL_INTENT_DEFINITIONS, AI_MODEL_INTENT_KEY, AI_MODEL_TYPE } from '@haohaoxue/lexora-contracts/ai/constants'

interface AiModelCapabilityTarget {
  modelType: AiModelType
  capabilities: AiModelCapability[]
}

interface AiModelLabelTarget {
  providerName: string
  modelName: string
  modelId: string
}

interface AiModelIntentRequirement {
  modelType: AiModelType
  requiredCapabilities: AiModelCapability[]
}

const AI_MODEL_INTENT_REQUIREMENTS = {
  [AI_MODEL_INTENT_KEY.CHAT_DEFAULT]: {
    modelType: AI_MODEL_TYPE.CHAT,
    requiredCapabilities: [],
  },
  [AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT]: {
    modelType: AI_MODEL_TYPE.CHAT,
    requiredCapabilities: [],
  },
  [AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT]: {
    modelType: AI_MODEL_TYPE.EMBEDDING,
    requiredCapabilities: [],
  },
} as const satisfies Record<AiModelIntentKey, AiModelIntentRequirement>

const TRAILING_SLASHES_RE = /\/+$/

export function compareAiModelRef(left: AiModelRef | null | undefined, right: AiModelRef | null | undefined) {
  if (!left || !right) {
    return false
  }

  return left.providerId === right.providerId && left.modelId === right.modelId
}

export function getAiModelIntentRequirement(intentKey: AiModelIntentKey): AiModelIntentRequirement {
  return {
    ...AI_MODEL_INTENT_REQUIREMENTS[intentKey],
    requiredCapabilities: [...AI_MODEL_INTENT_REQUIREMENTS[intentKey].requiredCapabilities],
  }
}

export function getAiModelIntentParentKey(intentKey: AiModelIntentKey): AiModelIntentKey | null {
  return AI_MODEL_INTENT_DEFINITIONS[intentKey].parentKey
}

export function getAiModelIntentFallbackChain(intentKey: AiModelIntentKey): AiModelIntentKey[] {
  const chain: AiModelIntentKey[] = []
  const visited = new Set<AiModelIntentKey>()
  let currentIntentKey: AiModelIntentKey | null = intentKey

  while (currentIntentKey) {
    if (visited.has(currentIntentKey)) {
      throw new Error(`AI model intent fallback cycle detected: ${currentIntentKey}`)
    }

    visited.add(currentIntentKey)
    chain.push(currentIntentKey)
    currentIntentKey = getAiModelIntentParentKey(currentIntentKey)
  }

  return chain
}

export function isAiModelCapabilitySatisfied(model: AiModelCapabilityTarget, intentKey: AiModelIntentKey) {
  const requirement = AI_MODEL_INTENT_REQUIREMENTS[intentKey]

  if (model.modelType !== requirement.modelType) {
    return false
  }

  return requirement.requiredCapabilities.every(capability => model.capabilities.includes(capability))
}

export function formatAiModelOptionLabel(option: AiModelLabelTarget) {
  const providerName = option.providerName.trim()
  const modelName = option.modelName.trim() || option.modelId.trim()

  return providerName ? `${providerName} / ${modelName}` : modelName
}

export function normalizeAiEndpoint(endpoint: string) {
  return endpoint.trim().replace(TRAILING_SLASHES_RE, '')
}
