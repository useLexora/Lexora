<script setup lang="ts">
import type { ExtensionSettingsHeaderAction } from '@buddy-shared/extensions/extensionSettingsHeaderActions'
import { Add20Regular, ArrowClockwise20Regular, ArrowDownload20Regular, ArrowLeft20Regular, MoreHorizontal20Regular, Settings20Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

defineProps<{ actions: readonly ExtensionSettingsHeaderAction[] }>()
defineEmits<{ activate: [id: string] }>()
const icons = { settings: Settings20Regular, download: ArrowDownload20Regular, refresh: ArrowClockwise20Regular, add: Add20Regular, back: ArrowLeft20Regular, more: MoreHorizontal20Regular }
</script>

<template>
  <div class="extension-settings-header-actions flex min-w-0 max-w-[min(60cqw,36rem)] items-center gap-2" data-extension-settings-header-actions>
    <NButton v-for="action in actions" :key="action.id" size="small" quaternary :disabled="action.disabled" :aria-label="typeof action.progress === 'number' ? `${action.title} ${Math.floor(action.progress)}%` : action.title" class="min-w-0 shrink-1" @click="$emit('activate', action.id)">
      <template v-if="action.progress !== undefined || action.icon" #icon>
        <span
          v-if="action.progress !== undefined"
          role="progressbar"
          :aria-label="action.title"
          :aria-valuenow="action.progress ?? undefined"
          :aria-valuemin="0"
          :aria-valuemax="100"
          class="inline-flex h-4 w-4 shrink-0"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" class="h-full w-full" :class="{ 'header-action-progress-indeterminate': action.progress === null }">
            <circle cx="12" cy="12" r="9" class="opacity-20" />
            <circle cx="12" cy="12" r="9" pathLength="100" stroke-linecap="round" :stroke-dasharray="action.progress === null ? '25 75' : '100'" :stroke-dashoffset="action.progress === null ? 0 : 100 - action.progress" transform="rotate(-90 12 12)" />
          </svg>
        </span>
        <DesktopIcon v-else-if="action.icon" :component="icons[action.icon]" :size="16" />
      </template>
      <span class="truncate">{{ action.title }}</span>
      <span v-if="typeof action.progress === 'number'" class="ml-1 shrink-0 text-xs tabular-nums">{{ Math.floor(action.progress) }}%</span>
    </NButton>
  </div>
</template>

<style scoped lang="scss">
.extension-settings-header-actions :deep(.n-button__content) {
  min-width: 0;
}

.header-action-progress-indeterminate {
  animation: header-action-progress-rotate 1s linear infinite;
}

@keyframes header-action-progress-rotate {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .header-action-progress-indeterminate {
    animation: none;
  }
}
</style>
