<script setup lang="ts">
import type { DesktopUpdateCheckResult } from '@buddy-electron/shared/desktopUpdates'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton, NDropdown } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ result: DesktopUpdateCheckResult, language: BuddyLocale, pending: boolean }>()
const emit = defineEmits<{ open: [], ignore: [version: string], dismiss: [], snooze: [version: string, delay: '30-minutes' | 'tomorrow'] }>()
const { t } = useBuddyI18n(() => props.language)
const options = computed(() => [
  { key: 'close', label: t('desktop.update.dismiss') },
  { key: '30-minutes', label: t('desktop.update.remindIn30Minutes') },
  { key: 'tomorrow', label: t('desktop.update.remindTomorrow') },
  { key: 'separator', type: 'divider' },
  { key: 'skip', label: t('desktop.update.ignore') },
])
function select(key: string) {
  if (key === 'close')
    emit('dismiss')
  else if (key === 'skip')
    emit('ignore', props.result.latestVersion)
  else if (key === '30-minutes' || key === 'tomorrow')
    emit('snooze', props.result.latestVersion, key)
}
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
        <NDropdown :menu-props="() => ({ role: 'menu' })" :node-props="option => ({ 'role': 'menuitem', 'aria-disabled': option.disabled ? 'true' : 'false' })" trigger="click" :options="options" @select="select">
          <NButton size="small" quaternary :disabled="pending">
            {{ t('desktop.update.later') }}
          </NButton>
        </NDropdown>
      </div>
    </NAlert>
  </aside>
</template>
