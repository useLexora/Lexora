<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { stepBrowserZoom } from '@buddy-shared/browser/browserPreferences'
import { Add16Regular, Subtract16Regular } from '@vicons/fluent'
import { NButton, NTooltip } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ language: BuddyLocale, zoomFactor: number, disabled: boolean }>()
const emit = defineEmits<{ zoom: [factor: number | null] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="browser-zoom" role="group" :aria-label="t('desktop.browser.zoom')">
    <span class="browser-zoom__label">{{ t('desktop.browser.zoom') }}</span>
    <NButton quaternary size="small" class="buddy-icon-button" :disabled="disabled || zoomFactor <= 0.5" :aria-label="t('desktop.browser.zoomOut')" @click="emit('zoom', stepBrowserZoom(zoomFactor, 'out'))">
      <DesktopIcon :component="Subtract16Regular" />
    </NButton>
    <NTooltip placement="top">
      <template #trigger>
        <NButton quaternary size="small" class="browser-zoom__value" :disabled="disabled" :aria-label="t('desktop.browser.resetZoom')" @click="emit('zoom', null)">
          {{ Math.round(zoomFactor * 100) }}%
        </NButton>
      </template>
      {{ t('desktop.browser.resetZoom') }}
    </NTooltip>
    <NButton quaternary size="small" class="buddy-icon-button" :disabled="disabled || zoomFactor >= 3" :aria-label="t('desktop.browser.zoomIn')" @click="emit('zoom', stepBrowserZoom(zoomFactor, 'in'))">
      <DesktopIcon :component="Add16Regular" />
    </NButton>
  </div>
</template>

<style scoped>
.browser-zoom { display: flex; align-items: center; gap: 0.1rem; padding: 0.2rem 0.55rem 0.2rem 0.9rem; }
.browser-zoom__label { margin-right: auto; padding-right: 1rem; font-size: 0.78rem; color: var(--buddy-text-primary); }
.browser-zoom__value { min-width: 3.5rem; font-variant-numeric: tabular-nums; }
</style>
