<script setup lang="ts">
import type { DesktopUpdateDeliveryState } from '@buddy-electron/shared/desktopUpdates'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NProgress } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatFileSize } from '@/shared/lib/formatFileSize'

const props = defineProps<{ delivery?: DesktopUpdateDeliveryState, version: string, language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const current = computed(() => props.delivery?.version === props.version ? props.delivery : undefined)
const downloading = computed(() => current.value?.status === 'downloading')
const description = computed(() => {
  const state = current.value
  if (!state || state.mode === 'release')
    return t('desktop.update.releaseFallback')
  if (state.status === 'error')
    return t('desktop.update.downloadFailed')
  if (state.status === 'verifying')
    return t('desktop.update.verifyingDescription')
  if (state.status === 'installing')
    return t('desktop.update.installingDescription')
  if (state.status === 'downloading')
    return state.totalBytes ? t('desktop.update.downloadProgress', { received: formatFileSize(state.downloadedBytes ?? 0), total: formatFileSize(state.totalBytes) }) : t('desktop.update.downloading')
  if (state.mode === 'open-package')
    return t(state.reason === 'system-package' ? 'desktop.update.systemPackage' : 'desktop.update.manualInstallation')
  if (state.status === 'ready')
    return t('desktop.update.readyDescription')
  return state.totalBytes ? t('desktop.update.packageSize', { size: formatFileSize(state.totalBytes) }) : ''
})
</script>

<template>
  <div v-if="description" class="desktop-update-delivery-status grid gap-[0.5rem] min-w-0">
    <NProgress v-if="downloading" type="line" :percentage="current?.progressPercent ?? 0" :height="4" />
    <p class="m-0 text-muted text-[12px] leading-[1.6] [overflow-wrap:anywhere]" :role="current?.status === 'error' ? 'alert' : 'status'">
      {{ description }}
    </p>
  </div>
</template>
