<script setup lang="ts">
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { ModelParameterActions } from './typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NCard, NModal } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopManualModelInfoPanel from '@/modules/models/widgets/providers/DesktopManualModelInfoPanel.vue'
import DesktopModelCapabilitiesPanel from '@/modules/models/widgets/providers/DesktopModelCapabilitiesPanel.vue'
import DesktopModelParametersPanel from '@/modules/models/widgets/providers/DesktopModelParametersPanel.vue'
import DesktopModelThinkingPanel from '@/modules/models/widgets/providers/DesktopModelThinkingPanel.vue'

const props = defineProps<{
  actions: ModelParameterActions | null
  language: BuddyLocale
  model: LocalRuntimeModelOption | null
  saving: boolean
  disabled: boolean
  show: boolean
}>()
const emit = defineEmits<{
  'update:show': [show: boolean]
}>()
const { t } = useBuddyI18n(() => props.language)
const modelSourceSummary = computed(() => (
  props.model ? t(`desktop.providers.modelSourceSummary.${props.model.source}`) : ''
))
</script>

<template>
  <NModal :show="show" @update:show="emit('update:show', $event)">
    <NCard
      v-if="model && actions"
      class="desktop-model-detail-dialog"
      closable
      content-style="min-height: 0; overflow: auto;"
      :style="{ width: 'min(40rem, calc(100vw - 2rem))' }"
      @close="emit('update:show', false)"
    >
      <template #header>
        <div class="desktop-model-detail-dialog__title grid min-w-0 gap-[0.12rem]">
          <strong>{{ model.displayName }}</strong>
          <span>{{ model.modelId }} · {{ modelSourceSummary }}</span>
        </div>
      </template>

      <div class="grid gap-[0.85rem]">
        <DesktopManualModelInfoPanel
          v-if="model.source === 'manual'"
          :actions="actions"
          :language="language"
          :saving="saving"
          :model="model"
          :show="show"
        />
        <DesktopModelCapabilitiesPanel
          :model="model"
          :actions="actions"
          :language="language"
          :saving="saving"
          :disabled="disabled"
          :show="show"
        />
        <DesktopModelThinkingPanel
          :actions="actions"
          :language="language"
          :saving="saving"
          :model="model"
          :disabled="disabled"
          :show="show"
        />
        <DesktopModelParametersPanel
          :model="model"
          :actions="actions"
          :language="language"
          :saving="saving"
          :show="show"
        />
      </div>
    </NCard>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-model-detail-dialog {
  max-height: min(42rem, calc(100dvh - 3rem));
  overflow: hidden;
}

.desktop-model-detail-dialog__title strong,
.desktop-model-detail-dialog__title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-model-detail-dialog__title span {
  color: var(--buddy-text-secondary);
  font-size: 0.68rem;
  font-weight: 400;
}
</style>
