<script setup lang="ts">
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronDown16Regular, Dismiss16Regular } from '@vicons/fluent'
import { NButton, NPopover, NTooltip } from 'naive-ui'
import { computed, shallowRef, useId, watch } from 'vue'
import { modelKey } from '@/modules/models'
import { DesktopModelPicker } from '@/modules/models/ui'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

type ModelReference = Pick<LocalRuntimeModelOption, 'providerId' | 'modelId'>
const props = defineProps<{
  value: ModelReference | null
  models: readonly LocalRuntimeModelOption[]
  providers: readonly LocalProvider[]
  language: BuddyLocale
  disabled: boolean
  labelId: string
  descriptionId?: string
}>()
const emit = defineEmits<{ change: [value: ModelReference | null] }>()
const valueId = useId()
const show = shallowRef(false)
const selectedId = computed(() => props.value ? modelKey(props.value) : null)
const inheritLabel = computed(() => props.language === 'en-US' ? 'Use this turn’s model' : '使用本轮模型')
const label = computed(() => {
  if (!props.value)
    return inheritLabel.value
  const model = props.models.find(model => modelKey(model) === selectedId.value)
  const provider = props.providers.find(provider => provider.id === props.value?.providerId)
  return `${model?.displayName ?? props.value.modelId} · ${provider?.displayName ?? props.value.providerId}${model ? '' : props.language === 'en-US' ? ' (Unavailable)' : '（不可用）'}`
})
watch(() => props.disabled, (disabled) => {
  if (disabled)
    show.value = false
})
function select(id: string) {
  const model = props.models.find(model => modelKey(model) === id)
  if (!props.disabled && model) {
    show.value = false
    emit('change', { providerId: model.providerId, modelId: model.modelId })
  }
}
</script>

<template>
  <div class="plugin-model-setting flex min-w-0 gap-1">
    <NPopover v-model:show="show" trigger="click" placement="bottom-end" raw :show-arrow="false" :disabled="disabled" to=".buddy-app">
      <template #trigger>
        <NButton class="plugin-model-setting__select flex-1 min-w-0" :disabled="disabled" :aria-labelledby="`${labelId} ${valueId}`" :aria-describedby="descriptionId" aria-haspopup="menu" :aria-expanded="show">
          <span :id="valueId" class="overflow-hidden text-ellipsis">{{ label }}</span>
          <DesktopIcon :component="ChevronDown16Regular" />
        </NButton>
      </template>
      <DesktopModelPicker :language="language" :models="models" :providers="providers" :selected-model-id="selectedId" @select="select" />
    </NPopover>
    <NTooltip v-if="value">
      <template #trigger>
        <NButton quaternary :disabled="disabled" :aria-label="inheritLabel" @click="emit('change', null)">
          <template #icon>
            <DesktopIcon :component="Dismiss16Regular" />
          </template>
        </NButton>
      </template>
      {{ inheritLabel }}
    </NTooltip>
  </div>
</template>

<style scoped lang="scss">
.plugin-model-setting__select {
  :deep(.n-button__content) {
    width: 100%;
    gap: 0.5rem;
    justify-content: space-between;
  }
}
</style>
