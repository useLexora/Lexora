<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NTooltip } from 'naive-ui'
import { nextTick } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ language: BuddyLocale, maximized: boolean, onLeft: boolean, canSwap: boolean }>()
const emit = defineEmits<{ swap: [], toggleMaximize: [] }>()
const { t } = useBuddyI18n(() => props.language)

async function swap(event: MouseEvent) {
  const button = event.currentTarget as HTMLButtonElement
  const restoreFocus = button.matches(':focus-visible')
  emit('swap')
  await nextTick()
  if (restoreFocus)
    button.focus({ preventScroll: true })
}
</script>

<template>
  <NTooltip v-if="canSwap && !maximized" :delay="350">
    <template #trigger>
      <button class="workbench-resource-panel-action grid w-8 h-8 flex-none place-items-center p-0 border-0 rounded-icon bg-transparent text-muted cursor-pointer hover:(bg-hover text-strong) ui-focus-ring" data-testid="context-panel-swap" type="button" :aria-label="t(onLeft ? 'desktop.context.moveToRight' : 'desktop.context.moveToLeft')" @click="swap">
        <DesktopIcon :size="16">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" />
          </svg>
        </DesktopIcon>
      </button>
    </template>
    {{ t(onLeft ? 'desktop.context.moveToRight' : 'desktop.context.moveToLeft') }}
  </NTooltip>
  <NTooltip :delay="350">
    <template #trigger>
      <button class="workbench-resource-panel-action grid w-8 h-8 flex-none place-items-center p-0 border-0 rounded-icon bg-transparent text-muted cursor-pointer hover:(bg-hover text-strong) ui-focus-ring" data-testid="context-panel-maximize" type="button" :aria-label="t(maximized ? 'desktop.context.restore' : 'desktop.context.maximize')" :aria-pressed="maximized" @click="emit('toggleMaximize')">
        <DesktopIcon :size="16">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="maximized ? 'm4 20 6-6m-6 0h6v6m10-16-6 6m0-6v6h6' : 'M14 4h6v6m0-6-6 6M4 14v6h6m-6 0 6-6'" />
          </svg>
        </DesktopIcon>
      </button>
    </template>
    {{ t(maximized ? 'desktop.context.restore' : 'desktop.context.maximize') }}
  </NTooltip>
</template>
