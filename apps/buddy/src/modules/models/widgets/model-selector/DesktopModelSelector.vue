<script setup lang="ts">
import type {
  BuddyServiceTier,
  BuddyThinkingLevel,
} from '@buddy-shared/conversation/modelSelection'

import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NPopover } from 'naive-ui'
import { computed, useTemplateRef } from 'vue'

import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopModelPicker from '@/modules/models/widgets/model-selector/DesktopModelPicker.vue'
import DesktopReasoningMeter from '@/modules/models/widgets/model-selector/DesktopReasoningMeter.vue'
import DesktopReasoningPicker from '@/modules/models/widgets/model-selector/DesktopReasoningPicker.vue'
import WorkbenchControl from '@/shared/ui/contributions/WorkbenchControl.vue'
import DesktopModelAdvancedPanel from './DesktopModelAdvancedPanel.vue'
import DesktopModelMainPanel from './DesktopModelMainPanel.vue'
import DesktopModelTrigger from './DesktopModelTrigger.vue'
import { useModelSelector } from './useModelSelector'

const props = withDefaults(defineProps<{
  clearable?: boolean
  disabled: boolean
  language: BuddyLocale
  models: ReadonlyArray<LocalRuntimeModelOption>
  placement?: 'bottom-start' | 'top-end'
  placeholder?: string
  providers: ReadonlyArray<LocalProvider>
  selectedEffort: BuddyThinkingLevel | null
  selectedModel: LocalRuntimeModelOption | null
  selectedModelId: string | null
  selectedServiceTier: BuddyServiceTier | null
  showFastMode?: boolean
  surface?: 'compact' | 'field'
}>(), {
  clearable: false,
  placement: 'top-end',
  placeholder: undefined,
  showFastMode: true,
  surface: 'compact',
})

const emit = defineEmits<{
  clearModel: []
  updateEffort: [value: BuddyThinkingLevel | null]
  updateModel: [value: string]
  updateServiceTier: [value: BuddyServiceTier | null]
}>()

const { t } = useBuddyI18n(() => props.language)
const modelLabel = computed(() => {
  if (props.selectedModel)
    return props.selectedModel.displayName
  if (props.selectedModelId !== null)
    return props.placeholder ?? t('desktop.chat.blocker.model.action')
  return props.placeholder ?? t('desktop.chat.noModels')
})
const root = useTemplateRef<HTMLElement>('root')
const {
  isOpen,
  activePanel,
  secondaryPanel,
  isMeterDragging,
  effortTransitionDirection,
  canClearModel,
  canOpen,
  reasoningLevelOptions,
  selectedEffortValue,
  isEffortUnavailable,
  displayedEffort,
  selectedEffortLabel,
  displayedEffortLabel,
  supportsFastMode,
  isFastMode,
  close,
  open,
  toggle,
  clearModel,
  toggleFastMode,
  openAdvancedPanel,
  openMainPanel,
  toggleSecondaryPanel,
  selectModel,
  selectEffort,
  selectMeterEffort,
  previewMeterEffort,
  updateMeterDragging,
} = useModelSelector(props, root, {
  clearModel: () => emit('clearModel'),
  updateEffort: value => emit('updateEffort', value),
  updateModel: value => emit('updateModel', value),
  updateServiceTier: value => emit('updateServiceTier', value),
})
function selectContributedEffort(value: string) {
  const option = reasoningLevelOptions.value.find(option => option.value === value)
  if (option && !props.disabled)
    selectMeterEffort(option.value)
}
defineExpose({
  close,
  open,
  toggle,
})
</script>

<template>
  <div ref="root" class="desktop-model-selector relative min-w-0">
    <NPopover
      class="buddy-raw-popover"
      raw
      trigger="manual"
      to=".buddy-app"
      :show="isOpen"
      :show-arrow="false"
      :animated="false"
      :placement="placement"
      :theme-overrides="{ space: placement === 'bottom-start' ? '0.55rem' : '0.65rem' }"
    >
      <template #trigger>
        <DesktopModelTrigger
          :language="language" :model-label="modelLabel" :selected-effort-label="selectedEffortLabel"
          :is-effort-unavailable="isEffortUnavailable" :is-fast-mode="isFastMode" :is-open="isOpen"
          :can-open="canOpen" :can-clear-model="canClearModel" :surface="surface"
          @toggle="toggle" @clear="clearModel"
        />
      </template>

      <div
        class="desktop-model-selector__popover flex max-w-[calc(100vw_-_3rem)] gap-2"
        :class="placement === 'bottom-start' ? 'is-bottom-start flex-row items-start' : 'is-top-end flex-row-reverse items-end'"
        @pointerdown.stop
      >
        <DesktopModelMainPanel
          v-if="activePanel === 'main'" :language="language" :is-meter-dragging="isMeterDragging"
          :effort-transition-direction="effortTransitionDirection" :displayed-effort="displayedEffort"
          :displayed-effort-label="displayedEffortLabel" :supports-fast-mode="supportsFastMode" :is-fast-mode="isFastMode"
          @advanced="openAdvancedPanel" @toggle-fast="toggleFastMode"
        >
          <template v-if="reasoningLevelOptions.length" #default>
            <WorkbenchControl target="model.reasoning" :context-key="selectedModelId ?? ''" :value="selectedEffortValue" :options="reasoningLevelOptions" :disabled="disabled" @change="selectContributedEffort" @dismiss="close">
              <DesktopReasoningPicker
                v-if="isEffortUnavailable"
                :language="language"
                :options="reasoningLevelOptions"
                :selected-effort="selectedEffortValue"
                @select="selectEffort"
              />
              <DesktopReasoningMeter
                v-else
                :label="t('desktop.chat.effort')"
                :options="reasoningLevelOptions"
                :selected-effort="selectedEffortValue"
                @dragging="updateMeterDragging"
                @preview="previewMeterEffort"
                @select="selectMeterEffort"
              />
            </WorkbenchControl>
          </template>
        </DesktopModelMainPanel>

        <DesktopModelAdvancedPanel
          v-else-if="activePanel === 'advanced'"
          :language="language"
          :model-label="modelLabel"
          :selected-effort-label="selectedEffortLabel"
          :is-effort-unavailable="isEffortUnavailable"
          :has-reasoning="reasoningLevelOptions.length > 0"
          :supports-fast-mode="supportsFastMode"
          :is-fast-mode="isFastMode"
          :secondary-panel="secondaryPanel"
          @back="openMainPanel"
          @panel="toggleSecondaryPanel"
          @toggle-fast="toggleFastMode"
        />

        <WorkbenchControl v-if="activePanel === 'advanced' && secondaryPanel === 'reasoning'" target="model.reasoning" :context-key="selectedModelId ?? ''" :value="selectedEffortValue" :options="reasoningLevelOptions" :disabled="disabled" @change="selectContributedEffort" @dismiss="close">
          <DesktopReasoningPicker
            :language="language"
            :options="reasoningLevelOptions"
            :selected-effort="selectedEffortValue"
            @select="selectEffort"
          />
        </WorkbenchControl>

        <DesktopModelPicker
          v-else-if="activePanel === 'advanced' && secondaryPanel === 'model'"
          :language="language"
          :models="models"
          :providers="providers"
          :selected-model-id="selectedModelId"
          @select="selectModel"
        />
      </div>
    </NPopover>
  </div>
</template>

<style scoped lang="scss">
.desktop-model-selector__popover {
  @media (max-width: 680px) {
    max-width: calc(100vw - 1.5rem);
    overflow-x: auto;
  }
}
</style>
