<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Compose20Regular } from '@vicons/fluent'
import { NButton, NTooltip } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = withDefaults(defineProps<{
  label: string
  language: BuddyLocale
  editing: boolean
  saving: boolean
  disabled?: boolean
  valid?: boolean
  canRestore?: boolean
}>(), { valid: true })
const emit = defineEmits<{ edit: [], cancel: [], save: [], restore: [] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <header class="desktop-model-section-header flex min-h-[2.8rem] flex-wrap items-center py-[0.6rem] px-4">
    <h3 class="m-0 text-[0.76rem]">
      {{ label }}
    </h3>
    <div class="desktop-model-section-header__trailing ml-auto">
      <NButton v-if="canRestore" quaternary size="small" :disabled="disabled || saving" @click="emit('restore')">
        {{ t('desktop.providers.restoreDefaultParameters') }}
      </NButton>
      <div v-if="editing" class="desktop-model-section-header__actions">
        <NButton size="small" :disabled="disabled || saving" @click="emit('cancel')">
          {{ t('common.cancel') }}
        </NButton>
        <NButton size="small" type="primary" :disabled="disabled || saving || valid === false" :loading="saving" @click="emit('save')">
          {{ t('common.save') }}
        </NButton>
      </div>
      <NTooltip v-else>
        <template #trigger>
          <NButton class="buddy-icon-button desktop-model-section-header__edit" quaternary size="small" :disabled="disabled || saving" :aria-label="t('common.edit')" @click="emit('edit')">
            <template #icon>
              <DesktopIcon :component="Compose20Regular" :size="16" />
            </template>
          </NButton>
        </template>
        {{ t('common.edit') }}
      </NTooltip>
    </div>
  </header>
</template>

<style scoped lang="scss">
.desktop-model-section-header {
  gap: 0.45rem 0.65rem;
}

.desktop-model-section-header__actions,
.desktop-model-section-header__trailing {
  display: flex;
  gap: 0.45rem;
}
</style>
