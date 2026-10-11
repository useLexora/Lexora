<script setup lang="ts">
import type { ThemeDescriptor } from '@buddy-shared/theme/themeDocument'
import { Desktop20Regular } from '@vicons/fluent'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ label: string, source: string, preview?: ThemeDescriptor['preview'], swatch?: string, system?: boolean }>()
const previewStyle = computed(() => ({
  '--theme-preview-canvas': props.preview?.canvas,
  '--theme-preview-surface': props.preview?.surface,
  '--theme-preview-accent': props.preview?.accent ?? props.swatch,
  '--theme-preview-fg': props.preview?.fg,
}))
</script>

<template>
  <span class="desktop-theme-option flex min-w-0 items-center gap-3 py-1">
    <span v-if="system" class="flex h-[30px] w-[42px] shrink-0 items-center justify-center border border-solid border-border rounded-micro bg-subtle text-muted" aria-hidden="true">
      <DesktopIcon :component="Desktop20Regular" :size="20" />
    </span>
    <span v-else class="desktop-theme-option__preview relative h-[30px] w-[42px] shrink-0 overflow-hidden border border-solid border-border rounded-micro" :style="previewStyle" aria-hidden="true">
      <span class="desktop-theme-option__sidebar absolute inset-y-0 left-0 w-[11px]" />
      <span class="desktop-theme-option__accent absolute top-[6px] right-[6px] h-[4px] w-[14px] rounded-[1px]" />
      <span class="desktop-theme-option__line absolute top-[15px] right-[6px] h-[2px] w-[18px] rounded-[1px]" />
      <span class="desktop-theme-option__line absolute top-[20px] right-[11px] h-[2px] w-[13px] rounded-[1px]" />
    </span>
    <span class="grid min-w-0 gap-[2px] leading-[1.35]">
      <span class="truncate text-[13px] font-500">{{ label }}</span>
      <span class="truncate text-[11px] text-muted">{{ source }}</span>
    </span>
  </span>
</template>

<style scoped lang="scss">
.desktop-theme-option__preview {
  background: var(--theme-preview-canvas, var(--buddy-surface-base));
}

.desktop-theme-option__sidebar {
  background: var(--theme-preview-surface, var(--buddy-surface-subtle));
  border-right: 1px solid color-mix(in srgb, var(--theme-preview-fg, var(--buddy-text-primary)) 12%, transparent);
}

.desktop-theme-option__accent {
  background: var(--theme-preview-accent, var(--buddy-accent-solid));
}

.desktop-theme-option__line {
  background: color-mix(in srgb, var(--theme-preview-fg, var(--buddy-text-primary)) 30%, transparent);
}
</style>
