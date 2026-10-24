<script setup lang="ts">
import type { DesktopUpdateDeliveryState } from '@buddy-electron/shared/desktopUpdates'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NProgress } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatFileSize } from '@/shared/lib/formatFileSize'

const props = defineProps<{ delivery?: DesktopUpdateDeliveryState, version: string, language: BuddyLocale, pending: boolean }>()
const { t } = useBuddyI18n(() => props.language)
const current = computed(() => props.delivery?.version === props.version ? props.delivery : undefined)
const downloading = computed(() => current.value?.status === 'downloading')
const failureDescription = computed(() => {
  const kind = current.value?.failure ?? 'download'
  const keys = { download: 'desktop.update.downloadFailureDescription', verification: 'desktop.update.verificationFailureDescription', storage: 'desktop.update.storageFailureDescription', timeout: 'desktop.update.timeoutFailureDescription' } as const
  return t(keys[kind])
})
const description = computed(() => {
  if (props.delivery?.reason === 'metadata-required')
    return t(props.pending ? 'desktop.update.checkingPackage' : 'desktop.update.packageInfoRequired')
  const state = current.value
  if (!state || state.mode === 'release')
    return t('desktop.update.releaseFallback')
  if (state.status === 'error')
    return failureDescription.value
  if (state.status === 'verifying')
    return t('desktop.update.verifyingDescription')
  if (state.status === 'installing')
    return t(state.reason === 'system-package' ? 'desktop.update.linuxInstallingDescription' : 'desktop.update.installingDescription')
  if (state.status === 'downloading')
    return state.totalBytes ? t('desktop.update.downloadProgress', { received: formatFileSize(state.downloadedBytes ?? 0), total: formatFileSize(state.totalBytes) }) : t('desktop.update.downloading')
  if (state.mode === 'open-package')
    return t(state.reason === 'portable-package' ? 'desktop.update.portableInstallation' : 'desktop.update.manualInstallation')
  if (state.mode === 'manual')
    return t(state.reason === 'installer-unavailable' ? 'desktop.update.installStepsFailed' : 'desktop.update.systemPackage')
  if (state.status === 'ready')
    return t(state.reason === 'system-package' ? 'desktop.update.linuxReadyDescription' : 'desktop.update.readyDescription')
  return state.totalBytes ? t('desktop.update.packageSize', { size: formatFileSize(state.totalBytes) }) : ''
})
</script>

<template>
  <div v-if="description" class="desktop-update-delivery-status grid gap-[0.5rem] min-w-0">
    <NProgress v-if="downloading" type="line" :percentage="current?.progressPercent ?? 0" :height="4" />
    <NAlert v-if="current?.status === 'error'" type="warning" :title="t(current.failure === 'verification' ? 'desktop.update.verificationFailed' : 'desktop.update.downloadFailed')" role="alert">
      {{ description }}
    </NAlert>
    <p v-else class="m-0 text-muted text-[12px] leading-[1.6] [overflow-wrap:anywhere]" role="status">
      {{ description }}
    </p>
  </div>
</template>
