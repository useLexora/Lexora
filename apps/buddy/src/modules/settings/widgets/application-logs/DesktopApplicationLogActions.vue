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
  <div class="log-actions flex items-center gap-[4px]">
    <div class="flex items-center gap-[8px] mr-[8px] whitespace-nowrap text-muted text-[12px]">
      <span :id="labelId">{{ t('applicationLogs.live') }}</span>
      <NSwitch size="small" :round="false" :value="live" :aria-labelledby="labelId" @update:value="emit('update:live', $event)" />
    </div>
    <span class="w-[1px] h-[16px] mr-[4px] bg-border" aria-hidden="true" />
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
