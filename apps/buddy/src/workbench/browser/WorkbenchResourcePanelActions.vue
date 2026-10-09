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
      <button class="workbench-resource-panel-action" data-testid="context-panel-swap" type="button" :aria-label="t(onLeft ? 'desktop.context.moveToRight' : 'desktop.context.moveToLeft')" @click="swap">
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
      <button class="workbench-resource-panel-action" data-testid="context-panel-maximize" type="button" :aria-label="t(maximized ? 'desktop.context.restore' : 'desktop.context.maximize')" :aria-pressed="maximized" @click="emit('toggleMaximize')">
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

<style scoped>
.workbench-resource-panel-action { display: grid; width: 2rem; height: 2rem; flex: none; place-items: center; padding: 0; border: 0; border-radius: var(--buddy-icon-button-radius); background: transparent; color: var(--buddy-text-secondary); cursor: pointer; }
.workbench-resource-panel-action:hover { background: var(--buddy-state-hover); color: var(--buddy-text-strong); }
.workbench-resource-panel-action:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: -2px; }
</style>
