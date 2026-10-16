<script setup lang="ts">
import type {
  CascaderNode,
  CascaderOption,
  CascaderProps,
  CascaderValue,
} from 'element-plus'
import type {
  ModelCascaderEmits,
  ModelCascaderModelRef,
  ModelCascaderOption,
  ModelCascaderProps,
} from './typing'
import type {
  AiAvailableModelOption,
  AiAvailableProviderOption,
  AiModelRef,
  AiProviderScope,
} from '@/apis/ai'
import { AI_PROVIDER_SCOPE } from '@haohaoxue/lexora-contracts/ai/constants'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getAvailableAiProviderModels,
  getAvailableAiProviders,
} from '@/apis/ai'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

const componentProps = withDefaults(defineProps<ModelCascaderProps>(), {
  modelValue: null,
  disabled: false,
  clearable: true,
  filterable: false,
  showAllLevels: true,
  allowedScopes: () => [AI_PROVIDER_SCOPE.PLATFORM, AI_PROVIDER_SCOPE.USER],
  hideUnavailable: false,
})
const emits = defineEmits<ModelCascaderEmits>()
const { t } = useI18n({ useScope: 'global' })
const VALUE_SEPARATOR = ':'
const SCOPE_VALUE_PREFIX = 'scope'
const PROVIDER_VALUE_PREFIX = 'provider'
const MODEL_VALUE_PREFIX = 'model'

const availableProvidersByScope = shallowRef<Partial<Record<AiProviderScope, AiAvailableProviderOption[]>>>({})
const providerLoadingPromises = shallowRef<Partial<Record<AiProviderScope, Promise<AiAvailableProviderOption[]>>>>({})
const availableModelsByProviderId = shallowRef<Record<string, AiAvailableModelOption[]>>({})
const modelLoadingPromises = shallowRef<Record<string, Promise<AiAvailableModelOption[]>>>({})
const cascaderRenderVersion = shallowRef(0)

const cascaderProps: CascaderProps = {
  lazy: true,
  emitPath: true,
  checkStrictly: false,
  lazyLoad: loadNode,
}

const selectedPath = computed<CascaderValue | null>({
  get: () => {
    const modelRef = componentProps.modelValue
      ? resolveModelRef(componentProps.modelValue)
      : null

    return modelRef ? buildModelPath(modelRef) : null
  },
  set: (value) => {
    emits('update:modelValue', parseModelPath(value))
  },
})
const cascaderRenderKey = computed(() => {
  const modelRef = componentProps.modelValue
  const modelKey = modelRef
    ? [
        modelRef.providerId,
        modelRef.modelId,
        modelRef.scope ?? '',
        modelRef.providerKey ?? '',
      ].join(':')
    : 'empty'

  return `${modelKey}:${cascaderRenderVersion.value}`
})

watch(() => componentProps.intentKey, () => {
  resetAvailableModels()
  void loadSelectedModelRefOptions()
})

watch(() => componentProps.allowedScopes, () => {
  resetAvailableModels()
  void loadSelectedModelRefOptions()
})

watch(() => componentProps.modelValue, () => {
  void loadSelectedModelRefOptions()
}, { immediate: true })

async function loadNode(
  node: CascaderNode,
  resolve: (dataList?: CascaderOption[]) => void,
  reject: () => void,
) {
  try {
    const nodeValue = getNodeValue(node)

    if (node.level === 0) {
      resolve(buildRootOptions())
      return
    }

    if (node.level === 1) {
      const scope = parseScopeValue(nodeValue)
      resolve(scope && isAllowedScope(scope) ? buildProviderOptions(await ensureAvailableProviders(scope)) : [])
      return
    }

    if (node.level === 2) {
      const providerId = parseProviderValue(nodeValue)
      resolve(providerId ? buildModelOptions(await ensureAvailableModels(providerId)) : [])
      return
    }

    resolve([])
  }
  catch (error) {
    reject()
    ElMessage.error(getRequestErrorDisplayMessage(error, t('modelCascader.loadFailed')))
  }
}

async function ensureAvailableProviders(scope: AiProviderScope) {
  const cachedProviders = availableProvidersByScope.value[scope]

  if (cachedProviders) {
    return cachedProviders
  }

  const loadingPromise = providerLoadingPromises.value[scope]

  if (loadingPromise) {
    return loadingPromise
  }

  const promise = (componentProps.availableProvidersLoader ?? getAvailableAiProviders)(componentProps.intentKey, scope)
    .then((providers) => {
      availableProvidersByScope.value = {
        ...availableProvidersByScope.value,
        [scope]: providers,
      }
      return providers
    })
    .finally(() => {
      const nextPromises = { ...providerLoadingPromises.value }
      delete nextPromises[scope]
      providerLoadingPromises.value = nextPromises
    })

  providerLoadingPromises.value = {
    ...providerLoadingPromises.value,
    [scope]: promise,
  }

  return promise
}

async function ensureAvailableModels(providerId: string) {
  const cachedModels = availableModelsByProviderId.value[providerId]

  if (cachedModels) {
    return cachedModels
  }

  const loadingPromise = modelLoadingPromises.value[providerId]

  if (loadingPromise) {
    return loadingPromise
  }

  const promise = (componentProps.availableProviderModelsLoader ?? getAvailableAiProviderModels)(componentProps.intentKey, providerId)
    .then((models) => {
      availableModelsByProviderId.value = {
        ...availableModelsByProviderId.value,
        [providerId]: models,
      }
      return models
    })
    .finally(() => {
      const nextPromises = { ...modelLoadingPromises.value }
      delete nextPromises[providerId]
      modelLoadingPromises.value = nextPromises
    })

  modelLoadingPromises.value = {
    ...modelLoadingPromises.value,
    [providerId]: promise,
  }

  return promise
}

async function loadSelectedModelRefOptions() {
  const modelRef = componentProps.modelValue

  if (!shouldLoadModelRefOptions(modelRef)) {
    return
  }

  try {
    const initialModelRef = resolveModelRef(modelRef)
    if (initialModelRef) {
      await ensureAvailableProviders(initialModelRef.scope)
    }

    await ensureAvailableModels(modelRef.providerId)

    const resolvedModelRef = resolveModelRef(modelRef)
    if (!resolvedModelRef) {
      emits('update:modelValue', null)
      return
    }

    await ensureAvailableProviders(resolvedModelRef.scope)
    cascaderRenderVersion.value += 1
  }
  catch (error) {
    ElMessage.error(getRequestErrorDisplayMessage(error, t('modelCascader.loadFailed')))
  }
}

function shouldLoadModelRefOptions(modelRef: ModelCascaderModelRef | null): modelRef is ModelCascaderModelRef {
  if (!modelRef) {
    return false
  }

  const resolvedModelRef = resolveModelRef(modelRef)
  return !resolvedModelRef
    || !availableProvidersByScope.value[resolvedModelRef.scope]
    || !availableModelsByProviderId.value[resolvedModelRef.providerId]
}

function resetAvailableModels() {
  availableProvidersByScope.value = {}
  providerLoadingPromises.value = {}
  availableModelsByProviderId.value = {}
  modelLoadingPromises.value = {}
}

function buildRootOptions(): ModelCascaderOption[] {
  return componentProps.allowedScopes.map(scope => ({
    value: buildScopeValue(scope),
    label: getScopeLabel(scope),
    leaf: false,
    nodeKind: 'scope',
    scope,
  }))
}

function buildProviderOptions(providers: AiAvailableProviderOption[]) {
  return providers
    .filter(provider => isAllowedScope(provider.scope))
    .map<ModelCascaderOption>(provider => ({
      value: buildProviderValue(provider.providerId),
      label: provider.providerName,
      leaf: false,
      nodeKind: 'provider',
      scope: provider.scope,
      providerId: provider.providerId,
      providerKey: provider.providerKey,
    }))
}

function buildModelOptions(models: AiAvailableModelOption[]) {
  return models
    .filter(item => isAllowedScope(item.scope))
    .filter(item => !componentProps.hideUnavailable || item.selectable)
    .map<ModelCascaderOption>(item => ({
      value: buildModelValue(item),
      label: item.modelName || item.modelId,
      disabled: !item.selectable,
      leaf: true,
      nodeKind: 'model',
      scope: item.scope,
      providerId: item.providerId,
      providerKey: item.providerKey,
      modelId: item.modelId,
      unavailableReason: item.unavailableReason,
    }))
}

function buildModelPath(modelRef: AiModelRef) {
  return [
    buildScopeValue(modelRef.scope),
    buildProviderValue(modelRef.providerId),
    buildModelValue(modelRef),
  ]
}

function parseModelPath(value: CascaderValue | null | undefined): AiModelRef | null {
  if (!Array.isArray(value)) {
    return null
  }

  const leafValue = value.at(-1)

  if (typeof leafValue !== 'string') {
    return null
  }

  const modelRef = parseModelValue(leafValue)

  return modelRef && isAllowedScope(modelRef.scope) ? modelRef : null
}

function resolveModelRef(modelRef: ModelCascaderModelRef): AiModelRef | null {
  if (modelRef.scope && modelRef.providerKey) {
    if (!isAllowedScope(modelRef.scope)) {
      return null
    }

    return {
      providerId: modelRef.providerId,
      scope: modelRef.scope,
      providerKey: modelRef.providerKey,
      modelId: modelRef.modelId,
    }
  }

  const matchedModel = availableModelsByProviderId.value[modelRef.providerId]?.find(item => item.modelId === modelRef.modelId && item.selectable && isAllowedScope(item.scope))

  return matchedModel
    ? {
        providerId: matchedModel.providerId,
        scope: matchedModel.scope,
        providerKey: matchedModel.providerKey,
        modelId: matchedModel.modelId,
      }
    : null
}

function buildScopeValue(scope: AiProviderScope) {
  return [SCOPE_VALUE_PREFIX, scope].join(VALUE_SEPARATOR)
}

function parseScopeValue(value: string): AiProviderScope | null {
  const parts = parsePrefixedValue(value, SCOPE_VALUE_PREFIX, 1)
  const scope = parts?.[0]

  return isAiProviderScope(scope) ? scope : null
}

function buildProviderValue(providerId: string) {
  return [PROVIDER_VALUE_PREFIX, encodeValuePart(providerId)].join(VALUE_SEPARATOR)
}

function parseProviderValue(value: string) {
  return parsePrefixedValue(value, PROVIDER_VALUE_PREFIX, 1)?.[0] ?? null
}

function buildModelValue(modelRef: Pick<AiModelRef, 'providerId' | 'scope' | 'providerKey' | 'modelId'>) {
  return [
    MODEL_VALUE_PREFIX,
    encodeValuePart(modelRef.providerId),
    modelRef.scope,
    encodeValuePart(modelRef.providerKey),
    encodeValuePart(modelRef.modelId),
  ].join(VALUE_SEPARATOR)
}

function parseModelValue(value: string): AiModelRef | null {
  const parts = parsePrefixedValue(value, MODEL_VALUE_PREFIX, 4)

  if (!parts) {
    return null
  }

  const [providerId, scope, providerKey, modelId] = parts

  if (!providerId || !isAiProviderScope(scope) || !providerKey || !modelId) {
    return null
  }

  return {
    providerId,
    scope,
    providerKey,
    modelId,
  }
}

function parsePrefixedValue(value: string, prefix: string, size: number) {
  const [actualPrefix, ...rawParts] = value.split(VALUE_SEPARATOR)

  if (actualPrefix !== prefix || rawParts.length !== size) {
    return null
  }

  try {
    return rawParts.map(decodeURIComponent)
  }
  catch {
    return null
  }
}

function encodeValuePart(value: string) {
  return encodeURIComponent(value)
}

function isAiProviderScope(value: string | undefined): value is AiProviderScope {
  return value === AI_PROVIDER_SCOPE.PLATFORM || value === AI_PROVIDER_SCOPE.USER
}

function isAllowedScope(scope: AiProviderScope) {
  return componentProps.allowedScopes.includes(scope)
}

function getScopeLabel(scope: AiProviderScope) {
  return scope === AI_PROVIDER_SCOPE.PLATFORM ? t('modelCascader.scope.platform') : t('modelCascader.scope.user')
}

function getNodeValue(node: CascaderNode) {
  const value = node.value ?? node.data.value

  return typeof value === 'string' ? value : ''
}

function getUnavailableReason(data: CascaderOption) {
  return typeof data.unavailableReason === 'string' ? data.unavailableReason : ''
}
</script>

<template>
  <ElCascader
    :key="cascaderRenderKey"
    v-model="selectedPath"
    class="model-cascader w-full"
    :props="cascaderProps"
    :placeholder="componentProps.placeholder ?? t('modelCascader.placeholder')"
    :disabled="componentProps.disabled"
    :clearable="componentProps.clearable"
    :filterable="componentProps.filterable"
    :show-all-levels="componentProps.showAllLevels"
    :popper-class="componentProps.popperClass"
  >
    <template #default="{ data }">
      <div class="model-cascader__node flex min-w-0 flex-1 items-center justify-between gap-2">
        <span class="model-cascader__label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ data.label }}</span>
        <span v-if="getUnavailableReason(data)" class="model-cascader__reason shrink-0 text-xs text-secondary">
          {{ getUnavailableReason(data) }}
        </span>
      </div>
    </template>
  </ElCascader>
</template>
