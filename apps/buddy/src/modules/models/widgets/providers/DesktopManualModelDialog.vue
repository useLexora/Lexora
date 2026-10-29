<script setup lang="ts">
import type { LocalCustomProviderModel } from '@buddy-shared/providers/providerApi'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NCard, NModal } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopManualModelForm from '@/modules/models/widgets/providers/DesktopManualModelForm.vue'

const props = defineProps<{
  allowChat?: boolean
  formKey: number
  language: BuddyLocale
  saving: boolean
  show: boolean
}>()
const emit = defineEmits<{
  'save': [model: LocalCustomProviderModel]
  'update:show': [show: boolean]
}>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <NCard
      class="desktop-manual-model-dialog"
      closable
      content-style="min-height: 0; overflow: auto;"
      :style="{ width: 'min(48rem, calc(100vw - 2rem))' }"
      @close="emit('update:show', false)"
    >
      <template #header>
        {{ t('desktop.providers.addModelManually') }}
      </template>
      <DesktopManualModelForm
        :key="formKey"
        :language="language"
        :allow-chat="allowChat"
        :saving="saving"
        @save="emit('save', $event)"
      />
    </NCard>
  </NModal>
</template>

<style scoped>
.desktop-manual-model-dialog {
  max-height: min(42rem, calc(100dvh - 3rem));
  overflow: hidden;
}

.desktop-manual-model-dialog.fade-in-scale-up-transition-enter-active,
.desktop-manual-model-dialog.fade-in-scale-up-transition-leave-active {
  transition: opacity 120ms ease-out !important;
}

.desktop-manual-model-dialog.fade-in-scale-up-transition-enter-from,
.desktop-manual-model-dialog.fade-in-scale-up-transition-enter-to,
.desktop-manual-model-dialog.fade-in-scale-up-transition-leave-from,
.desktop-manual-model-dialog.fade-in-scale-up-transition-leave-to {
  transform: none !important;
}
</style>
