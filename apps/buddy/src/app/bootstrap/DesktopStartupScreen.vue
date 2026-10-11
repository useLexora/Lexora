<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopStartupArtwork from './DesktopStartupArtwork.vue'

const props = defineProps<{ failed: boolean, language: BuddyLocale }>()
const emit = defineEmits<{ retry: [], openLogs: [] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="desktop-startup [--startup-avatar-size:clamp(10rem,26vmin,15rem)] absolute z-20 inset-0 overflow-hidden bg-surface select-none" :class="{ 'is-failed': failed }" :role="failed ? 'alert' : 'status'" :aria-busy="!failed">
    <DesktopStartupArtwork :still="failed" />
    <div class="desktop-startup__identity absolute top-[calc(50%_+_var(--startup-avatar-size)_/_2_+_1rem)] left-[50%] grid w-[min(28rem,_calc(100%_-_3rem))] gap-[0.85rem] justify-items-center font-brand text-center -translate-x-1/2">
      <h1 class="m-0 text-fg text-[1.25rem] font-500 tracking-[0.09em]">
        Lexora Buddy
      </h1>
      <p class="m-0 text-muted text-[0.75rem]">
        {{ t(failed ? 'desktop.loading.failed' : 'desktop.loading.app') }}
      </p>
      <div v-if="failed" class="flex gap-2 mt-[0.4rem]">
        <NButton size="small" secondary @click="emit('retry')">
          {{ t('desktop.loading.retry') }}
        </NButton>
        <NButton size="small" quaternary @click="emit('openLogs')">
          {{ t('applicationLogs.open') }}
        </NButton>
      </div>
    </div>
  </div>
</template>
