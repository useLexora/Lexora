<script setup lang="ts">
import { useDelayedLoading } from './useDelayedLoading'

const props = defineProps<{ loading: boolean, label: string, tree?: boolean }>()
const visible = useDelayedLoading(() => props.loading)
</script>

<template>
  <div class="desktop-file-loading flex-1 min-w-0 pointer-events-none" :aria-busy="loading">
    <div v-if="visible" class="desktop-file-loading__placeholder max-w-[600px] text-muted text-[11px]" :class="tree ? 'py-[8px] px-[12px]' : 'p-[16px]'" role="status">
      <span>{{ label }}</span>
      <div class="mt-[12px]" aria-hidden="true">
        <div v-for="width in [72, 52, 86, 64, 40]" :key="width" class="flex items-center gap-[8px] h-[24px]">
          <span v-if="tree" class="bg-border w-[14px] h-[14px] shrink-0 rounded-[3px]" />
          <span class="bg-border h-[6px] rounded-[3px]" :style="{ width: `${width}%` }" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-file-loading__placeholder { animation: file-loading-reveal 160ms ease both; }
.bg-border { background: var(--buddy-border-subtle); }
@keyframes file-loading-reveal { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .desktop-file-loading__placeholder { animation: none; }
}
</style>
