<script setup lang="ts">
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { CheckboxProps } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NCheckbox } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = withDefaults(defineProps<{
  language: BuddyLocale
  model: LocalRuntimeModelOption
  compact?: boolean
}>(), { compact: true })
const { t } = useBuddyI18n(() => props.language)
const capabilities = computed(() => {
  const items = [
    { label: t('desktop.providers.imageAttachment'), enabled: props.model.capabilities.includes('image') },
    { label: t('desktop.providers.pdfAttachment'), enabled: props.model.capabilities.includes('pdf') },
    { label: t('desktop.providers.audioAttachment'), enabled: props.model.capabilities.includes('audio') },
    { label: t('desktop.providers.videoAttachment'), enabled: props.model.capabilities.includes('video') },
  ]
  return items
})
const checkboxThemeOverrides = computed<CheckboxProps['themeOverrides']>(() => ({
  ...(props.compact
    ? {
        fontSizeSmall: '0.68rem',
        sizeSmall: '0.7rem',
        labelPadding: '0 0 0 0.25rem',
      }
    : {}),
  textColorDisabled: 'var(--buddy-text-secondary)',
  colorDisabled: 'transparent',
  colorDisabledChecked: 'var(--buddy-accent-solid)',
  borderDisabledChecked: '1px solid var(--buddy-accent-solid)',
  checkMarkColorDisabledChecked: 'var(--buddy-text-on-accent)',
}))
</script>

<template>
  <div class="desktop-model-capability-tags flex min-w-0 flex-wrap items-center text-muted" :class="{ 'desktop-model-capability-tags--compact': compact }">
    <NCheckbox
      v-for="capability in capabilities"
      :key="capability.label"
      class="desktop-model-capability-tags__item"
      :checked="capability.enabled"
      :label="capability.label"
      :theme-overrides="checkboxThemeOverrides"
      :focusable="false"
      size="small"
      disabled
    />
  </div>
</template>

<style scoped lang="scss">
.desktop-model-capability-tags {
  gap: 0.45rem 1rem;
}

.desktop-model-capability-tags--compact {
  gap: 0.3rem 0.7rem;
  font-size: 0.68rem;
}

.desktop-model-capability-tags .desktop-model-capability-tags__item {
  cursor: default;
  white-space: nowrap;
}
</style>
