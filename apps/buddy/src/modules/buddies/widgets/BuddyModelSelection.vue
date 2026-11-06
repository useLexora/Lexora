<script setup lang="ts">
import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { BuddySettings } from '@buddy-shared/buddies/buddySettings'
import type { BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import {
  ChevronDown16Regular,
  Dismiss16Regular,
} from '@vicons/fluent'
import { NButton, NPopover } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { modelKey, resolveConcreteEffort } from '@/modules/models'
import { DesktopModelPicker, DesktopReasoningPicker } from '@/modules/models/ui'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { buddyLabels } from '../buddyLabels'

const props = defineProps<{
  kind: LocalBuddy['kind']
  models: readonly LocalRuntimeModelOption[]
  providers?: readonly LocalProvider[]
  disabled: boolean
}>()
const model = defineModel<BuddySettings['model']>({ required: true })
const { language } = useDesktopUi()
const { t } = useBuddyI18n(language)
const labels = computed(() => buddyLabels(language.value))
const showModelPicker = shallowRef(false)
const showReasoningPicker = shallowRef(false)
const modelLabelId = useId()
const modelValueId = useId()
const reasoningLabelId = useId()
const reasoningValueId = useId()
const modelDefault = computed(() => props.kind === 'npc' ? labels.value.npcModelDefault : labels.value.actorModelDefault)

const selectedModelKey = computed(() => model.value ? `${model.value.providerId}:${model.value.modelId}` : null)
const selectedModel = computed(() => {
  if (!model.value)
    return null
  return props.models.find(option => option.providerId === model.value?.providerId && option.modelId === model.value?.modelId) ?? null
})
const reasoningOptions = computed(() => selectedModel.value?.reasoningOptions.map(value => ({
  value,
  label: `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`,
})) ?? [])
const selectedReasoning = computed(() => model.value?.reasoning
  ?? (selectedModel.value ? resolveConcreteEffort(selectedModel.value, null) : null))
const reasoningDisplayLabel = computed(() => reasoningOptions.value.find(option => option.value === selectedReasoning.value)?.label
  ?? selectedReasoning.value)

const modelDisplayLabel = computed(() => {
  if (!model.value)
    return modelDefault.value
  const provider = props.providers?.find(p => p.id === model.value?.providerId)
  const providerName = provider?.displayName ?? model.value.providerId
  return `${selectedModel.value?.displayName ?? model.value.modelId} · ${providerName}`
})

function onSelectModel(key: string) {
  if (props.disabled)
    return
  const found = props.models.find(model => modelKey(model) === key)
  if (!found)
    return
  if (key !== selectedModelKey.value) {
    model.value = {
      providerId: found.providerId,
      modelId: found.modelId,
      reasoning: resolveConcreteEffort(found, model.value?.reasoning ?? null),
      serviceTier: null,
    }
  }
  showModelPicker.value = false
  showReasoningPicker.value = false
}

function onSelectReasoning(reasoning: BuddyThinkingLevel) {
  if (props.disabled || !model.value || !selectedModel.value?.reasoningOptions.includes(reasoning))
    return
  model.value = { ...model.value, reasoning }
  showReasoningPicker.value = false
}

function clearModel() {
  if (props.disabled)
    return
  model.value = null
  showReasoningPicker.value = false
}
</script>

<template>
  <div class="border-y border-y-solid border-y-border">
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <span :id="modelLabelId" class="text-[13px] font-600 text-fg">{{ labels.preferredModel }}</span>
      <div class="flex min-w-0 max-w-[min(100%,22rem)] items-center gap-1">
        <NPopover
          v-model:show="showModelPicker"
          trigger="click"
          placement="bottom-start"
          raw
          :show-arrow="false"
          :disabled="disabled"
          to=".buddy-app"
        >
          <template #trigger>
            <NButton
              quaternary
              size="small"
              class="buddy-model-picker min-w-0 max-w-full"
              :disabled="disabled"
              :aria-labelledby="`${modelLabelId} ${modelValueId}`"
              :aria-expanded="showModelPicker"
            >
              <span
                :id="modelValueId"
                class="min-w-0 flex-1 truncate text-left text-[13px]"
                :class="model ? 'text-fg font-500' : 'text-muted'"
              >
                {{ modelDisplayLabel }}
              </span>
              <DesktopIcon :component="ChevronDown16Regular" class="ml-2 shrink-0 text-muted" />
            </NButton>
          </template>

          <DesktopModelPicker
            :language="language"
            :models="models"
            :providers="providers ?? []"
            :selected-model-id="selectedModelKey"
            @select="onSelectModel"
          />
        </NPopover>
        <NButton v-if="model" quaternary size="small" class="buddy-icon-button shrink-0" :disabled="disabled" :aria-label="modelDefault" @click="clearModel">
          <template #icon>
            <DesktopIcon :component="Dismiss16Regular" />
          </template>
        </NButton>
      </div>
    </div>
    <div v-if="reasoningOptions.length" class="flex flex-wrap items-center justify-between gap-3 border-t border-t-solid border-t-border px-4 py-3">
      <span :id="reasoningLabelId" class="text-[13px] font-600 text-fg">{{ t('desktop.chat.effort') }}</span>
      <NPopover
        v-model:show="showReasoningPicker"
        trigger="click"
        placement="bottom-end"
        raw
        :show-arrow="false"
        :disabled="disabled"
        to=".buddy-app"
      >
        <template #trigger>
          <NButton
            quaternary
            size="small"
            :disabled="disabled"
            :aria-labelledby="`${reasoningLabelId} ${reasoningValueId}`"
            :aria-expanded="showReasoningPicker"
          >
            <span :id="reasoningValueId" class="text-[13px] font-500">{{ reasoningDisplayLabel }}</span>
            <DesktopIcon :component="ChevronDown16Regular" class="ml-2 shrink-0 text-muted" />
          </NButton>
        </template>
        <DesktopReasoningPicker
          :language="language"
          :options="reasoningOptions"
          :selected-effort="selectedReasoning"
          :disabled="disabled"
          @select="onSelectReasoning"
        />
      </NPopover>
    </div>
  </div>
</template>

<style scoped lang="scss">
.buddy-model-picker :deep(.n-button__content) {
  width: 100%;
  min-width: 0;
}
</style>
