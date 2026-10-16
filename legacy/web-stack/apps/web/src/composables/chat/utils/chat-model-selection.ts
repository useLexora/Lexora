import type { AiModelRef } from '@/apis/ai'
import type { ChatModelItem, ChatModelSelection, ChatRuntimeConfig } from '@/apis/chat'

export type ChatModelDisplayRef = NonNullable<ChatModelSelection['modelRef']> & Partial<Pick<AiModelRef, 'scope' | 'providerKey'>>

export function normalizeModelSelection(value: ChatModelSelection): ChatModelSelection {
  return {
    modelRef: value.modelRef
      ? {
          providerId: value.modelRef.providerId.trim(),
          modelId: value.modelRef.modelId.trim(),
        }
      : null,
  }
}

export function normalizeNullableModelRef(
  value: ChatModelSelection['modelRef'] | null | undefined,
): ChatModelSelection['modelRef'] | null {
  if (!value) {
    return null
  }

  return normalizeModelSelection({ modelRef: value }).modelRef ?? null
}

export function toModelRef(
  value: Pick<AiModelRef, 'providerId' | 'modelId'> | null | undefined,
): ChatModelSelection['modelRef'] | null {
  if (!value) {
    return null
  }

  return {
    providerId: value.providerId.trim(),
    modelId: value.modelId.trim(),
  }
}

export function isSameNullableModelRef(
  left: Pick<AiModelRef, 'providerId' | 'modelId'> | null | undefined,
  right: Pick<AiModelRef, 'providerId' | 'modelId'> | null | undefined,
) {
  const leftModelRef = toModelRef(left)
  const rightModelRef = toModelRef(right)

  if (!leftModelRef || !rightModelRef) {
    return !leftModelRef && !rightModelRef
  }

  return isSameModelRef(leftModelRef, rightModelRef)
}

export function createEmptyRuntimeConfig(): ChatRuntimeConfig {
  return {
    enabled: false,
    ready: false,
    defaultModel: null,
    notReadyReason: null,
  }
}

export function findMatchingModelOption(
  modelOptions: ChatModelItem[],
  modelRef: NonNullable<ChatModelSelection['modelRef']>,
): ChatModelItem | null {
  return modelOptions.find(model => model.providerId === modelRef.providerId && model.modelId === modelRef.modelId) ?? null
}

export function resolveSelectedChatModel(
  modelRef: ChatModelSelection['modelRef'] | null | undefined,
  modelOptions: ChatModelItem[],
  runtimeDefaultModel: ChatModelItem | null,
): ChatModelItem | null {
  const normalizedModelRef = normalizeNullableModelRef(modelRef)

  if (normalizedModelRef) {
    const matchedModel = findMatchingModelOption(modelOptions, normalizedModelRef)
    if (matchedModel?.selectable) {
      return matchedModel
    }

    if (
      runtimeDefaultModel
      && runtimeDefaultModel.providerId === normalizedModelRef.providerId
      && runtimeDefaultModel.modelId === normalizedModelRef.modelId
    ) {
      return runtimeDefaultModel
    }

    return null
  }

  return runtimeDefaultModel ?? null
}

export function resolveChatRequestModelRef(
  modelRef: ChatModelSelection['modelRef'] | null | undefined,
  modelOptions: ChatModelItem[],
  runtimeDefaultModel: ChatModelItem | null,
): ChatModelDisplayRef | null {
  const normalizedModelRef = normalizeNullableModelRef(modelRef)

  if (normalizedModelRef) {
    const matchedModel = findMatchingModelOption(modelOptions, normalizedModelRef)
    if (matchedModel?.selectable) {
      return toModelDisplayRef(matchedModel)
    }

    if (
      runtimeDefaultModel
      && runtimeDefaultModel.providerId === normalizedModelRef.providerId
      && runtimeDefaultModel.modelId === normalizedModelRef.modelId
    ) {
      return toModelDisplayRef(runtimeDefaultModel)
    }

    return normalizedModelRef
  }

  return toModelDisplayRef(runtimeDefaultModel)
}

export function toModelDisplayRef(
  value: Pick<AiModelRef, 'providerId' | 'modelId'> & Partial<Pick<AiModelRef, 'scope' | 'providerKey'>> | null | undefined,
): ChatModelDisplayRef | null {
  const modelRef = toModelRef(value)
  if (!modelRef) {
    return null
  }

  return {
    ...modelRef,
    ...(value?.scope ? { scope: value.scope } : {}),
    ...(value?.providerKey?.trim() ? { providerKey: value.providerKey.trim() } : {}),
  }
}

function isSameModelRef(
  left: Pick<AiModelRef, 'providerId' | 'modelId'>,
  right: Pick<AiModelRef, 'providerId' | 'modelId'>,
) {
  return left.providerId === right.providerId && left.modelId === right.modelId
}
