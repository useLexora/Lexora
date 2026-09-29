<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowDownload20Regular, Pulse20Regular } from '@vicons/fluent'
import { NButton, NSwitch } from 'naive-ui'
import { useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ language: BuddyLocale, live: boolean, exporting: boolean }>()
const emit = defineEmits<{ 'update:live': [value: boolean], 'performance': [], 'export': [] }>()
const { t } = useBuddyI18n(() => props.language)
const labelId = useId()
const buttonTheme = { fontSizeSmall: '12px', iconSizeSmall: '16px', paddingSmall: '0 8px' }
</script>

<template>
  <div class="log-actions">
    <div class="log-actions__live">
      <span :id="labelId">{{ t('applicationLogs.live') }}</span>
      <NSwitch size="small" :round="false" :value="live" :aria-labelledby="labelId" @update:value="emit('update:live', $event)" />
    </div>
    <span class="log-actions__divider" aria-hidden="true" />
    <NButton class="log-actions__button" size="small" quaternary :theme-overrides="buttonTheme" @click="emit('performance')">
      <template #icon>
        <DesktopIcon :component="Pulse20Regular" :size="16" />
      </template>
      {{ t('applicationLogs.performance.title') }}
    </NButton>
    <NButton class="log-actions__button" size="small" quaternary :theme-overrides="buttonTheme" :loading="exporting" :disabled="exporting" @click="emit('export')">
      <template #icon>
        <DesktopIcon :component="ArrowDownload20Regular" :size="16" />
      </template>
      {{ t('applicationLogs.exportDiagnostics') }}
    </NButton>
  </div>
</template>

<style scoped>
.log-actions { display: flex; align-items: center; gap: 4px; }
.log-actions__live { display: flex; align-items: center; gap: 8px; margin-right: 8px; white-space: nowrap; color: var(--buddy-text-secondary); font-size: 12px; }
.log-actions__divider { width: 1px; height: 16px; margin-right: 4px; background: var(--buddy-border-subtle); }
</style>
