<script setup lang="ts">
import type { DesktopUpdateCheckResult } from '@buddy-electron/shared/desktopUpdates'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ result: DesktopUpdateCheckResult, language: BuddyLocale, pending: boolean }>()
const emit = defineEmits<{ open: [], ignore: [version: string], dismiss: [] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <aside class="desktop-update-reminder fixed z-1900 right-[20px] bottom-[20px] w-[min(340px,_calc(100vw_-_40px))] shadow-soft" data-testid="update-reminder" aria-live="polite">
    <NAlert :title="t('desktop.update.notificationTitle', { version: result.latestVersion })" :show-icon="false" closable @close="emit('dismiss')">
      <p class="mt-[4px] mr-0 mb-[12px] ml-0 text-muted text-[12px] leading-[1.6]">
        {{ t('desktop.update.notificationDescription') }}
      </p>
      <div class="flex gap-[8px]">
        <NButton size="small" type="primary" :disabled="pending" @click="emit('open')">
          {{ t('desktop.update.view') }}
        </NButton>
        <NButton size="small" quaternary :disabled="pending" @click="emit('ignore', result.latestVersion)">
          {{ t('desktop.update.ignore') }}
        </NButton>
      </div>
    </NAlert>
  </aside>
</template>
