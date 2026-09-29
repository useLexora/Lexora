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
  <aside class="desktop-update-reminder" data-testid="update-reminder" aria-live="polite">
    <NAlert :title="t('desktop.update.notificationTitle', { version: result.latestVersion })" :show-icon="false" closable @close="emit('dismiss')">
      <p class="desktop-update-reminder__description">
        {{ t('desktop.update.notificationDescription') }}
      </p>
      <div class="desktop-update-reminder__actions">
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

<style scoped>
.desktop-update-reminder {
  position: fixed;
  z-index: 1900;
  right: 20px;
  bottom: 20px;
  width: min(340px, calc(100vw - 40px));
  box-shadow: var(--buddy-shadow-soft);
}
.desktop-update-reminder__description {
  margin: 4px 0 12px;
  color: var(--buddy-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.desktop-update-reminder__actions {
  display: flex;
  gap: 8px;
}
</style>
