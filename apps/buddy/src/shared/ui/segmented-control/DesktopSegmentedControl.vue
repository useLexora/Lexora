<script setup lang="ts" generic="T extends string | number">
import type { GlobalThemeOverrides } from 'naive-ui'
import { NTab, NTabs } from 'naive-ui'

const props = defineProps<{
  options: readonly { label: string, value: T }[]
  disabled?: boolean
}>()
const value = defineModel<T>({ required: true })
const themeOverrides: GlobalThemeOverrides['Tabs'] = {
  colorSegment: 'var(--buddy-surface-subtle)',
  tabColorSegment: 'var(--buddy-surface-base)',
  tabTextColorSegment: 'var(--buddy-text-secondary)',
  tabTextColorActiveSegment: 'var(--buddy-text-strong)',
  tabTextColorHoverSegment: 'var(--buddy-text-strong)',
  tabFontSizeSmall: '13px',
  tabFontWeight: '580',
  fontWeightStrong: '580',
  tabBorderRadius: 'var(--buddy-radius-micro)',
  tabPaddingSmallSegment: '4px 12px',
}

function select(next: string | number) {
  const option = props.options.find(option => option.value === next)
  if (!props.disabled && option && option.value !== value.value)
    value.value = option.value
}
</script>

<template>
  <NTabs
    class="desktop-segmented-control"
    role="group"
    type="segment"
    size="small"
    animated
    :value="value"
    :theme-overrides="themeOverrides"
    @update:value="select"
  >
    <NTab
      v-for="option in options"
      :key="option.value"
      :name="option.value"
      :disabled="disabled"
      role="button"
      :tabindex="disabled ? -1 : 0"
      :aria-pressed="value === option.value"
      :aria-disabled="disabled || undefined"
      @keydown.enter.prevent="select(option.value)"
      @keydown.space.prevent="select(option.value)"
    >
      {{ option.label }}
    </NTab>
  </NTabs>
</template>

<style scoped>
.desktop-segmented-control {
  width: max-content;
  max-width: 100%;
  flex: none;
}

.desktop-segmented-control :deep(.n-tabs-tab:focus-visible) {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
  .desktop-segmented-control :deep(.n-tabs-capsule) {
    transition: none;
  }
}
</style>
