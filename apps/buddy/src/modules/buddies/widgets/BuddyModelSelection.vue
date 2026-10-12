<script setup lang="ts">
import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { BuddySettings } from '@buddy-shared/buddies/buddySettings'
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import {
  ChevronDown16Regular,
  Dismiss16Regular,
} from '@vicons/fluent'
import { NButton, NPopover } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { modelKey, resolveConcreteEffort } from '@/modules/models'
import { DesktopModelPicker } from '@/modules/models/ui'
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
const labels = computed(() => buddyLabels(language.value))
const showModelPicker = shallowRef(false)
const modelLabelId = useId()
const modelValueId = useId()
const modelDefault = computed(() => props.kind === 'npc' ? labels.value.npcModelDefault : labels.value.actorModelDefault)

const selectedModelKey = computed(() => model.value ? `${model.value.providerId}:${model.value.modelId}` : null)
const selectedModel = computed(() => {
  if (!model.value)
    return null
  return props.models.find(option => option.providerId === model.value?.providerId && option.modelId === model.value?.modelId) ?? null
})

const modelDisplayLabel = computed(() => {
  if (!model.value)
    return modelDefault.value
  const provider = props.providers?.find(p => p.id === model.value?.providerId)
  const providerName = provider?.displayName ?? model.value.providerId
  return `${selectedModel.value?.displayName ?? model.value.modelId} · ${providerName}`
})

function onSelectModel(key: string) {
  const found = props.models.find(model => modelKey(model) === key)
  if (!found)
    return
  model.value = {
    providerId: found.providerId,
    modelId: found.modelId,
    reasoning: resolveConcreteEffort(found, null),
    serviceTier: null,
  }
  showModelPicker.value = false
}

function clearModel() {
  model.value = null
}
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3 border-y border-y-solid border-y-border px-4 py-3">
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
</template>

<style scoped lang="scss">
.buddy-model-picker :deep(.n-button__content) {
  width: 100%;
  min-width: 0;
}
</style>
