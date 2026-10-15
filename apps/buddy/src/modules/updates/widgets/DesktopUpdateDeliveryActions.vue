<script setup lang="ts">
import type { DesktopUpdateDeliveryState } from '@buddy-electron/shared/desktopUpdates'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton } from 'naive-ui'
import { computed, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  delivery?: DesktopUpdateDeliveryState
  version: string
  language: BuddyLocale
  pending: boolean
  manualInstallation?: boolean
}>()
const emit = defineEmits<{
  check: []
  download: []
  cancel: []
  install: []
  openPackage: []
  openRelease: []
  showInstallation: []
}>()
const { t } = useBuddyI18n(() => props.language)
const labelId = useId()
const supported = computed(() => props.delivery?.version === props.version && props.delivery.mode !== 'release' && props.delivery.status !== 'idle')
const downloading = computed(() => supported.value && props.delivery?.status === 'downloading')
const ready = computed(() => supported.value && ['ready', 'installing'].includes(props.delivery!.status))
const verifying = computed(() => supported.value && props.delivery?.status === 'verifying')
</script>

<template>
  <NButton v-if="ready && manualInstallation && delivery?.mode === 'restart'" :disabled="pending || delivery.status === 'installing'" @click="emit('showInstallation')">
    {{ t('desktop.update.viewInstallSteps') }}
  </NButton>
  <NButton v-if="(supported && delivery?.status === 'error') || (delivery?.reason === 'metadata-required' && !pending)" :disabled="pending" @click="emit('openRelease')">
    {{ t('desktop.update.manualDownload') }}
  </NButton>
  <NButton v-if="delivery?.reason === 'metadata-required'" :aria-labelledby="labelId" type="primary" :disabled="pending" :loading="pending" @click="emit('check')">
    <span :id="labelId">{{ t(pending ? 'desktop.update.checking' : 'desktop.update.retryCheck') }}</span>
  </NButton>
  <NButton v-else-if="verifying" :aria-labelledby="labelId" disabled loading>
    <span :id="labelId">{{ t('desktop.update.verifying') }}</span>
  </NButton>
  <NButton v-else-if="downloading" :aria-labelledby="labelId" :disabled="pending" @click="emit('cancel')">
    <span :id="labelId">{{ t('desktop.update.cancelDownload') }}</span>
  </NButton>
  <NButton v-else-if="ready && delivery?.mode === 'restart'" :aria-labelledby="labelId" type="primary" :disabled="pending" :loading="delivery?.status === 'installing'" @click="emit('install')">
    <span :id="labelId">{{ t(delivery?.status === 'installing' ? 'desktop.update.installing' : manualInstallation ? 'desktop.update.installUpdate' : 'desktop.update.restart') }}</span>
  </NButton>
  <NButton v-else-if="ready && delivery?.mode === 'manual'" type="primary" :disabled="pending" @click="emit('showInstallation')">
    {{ t('desktop.update.viewInstallSteps') }}
  </NButton>
  <NButton v-else-if="ready" :aria-labelledby="labelId" type="primary" :disabled="pending" @click="emit('openPackage')">
    <span :id="labelId">{{ t('desktop.update.openPackage') }}</span>
  </NButton>
  <NButton v-else-if="supported" :aria-labelledby="labelId" type="primary" :loading="pending" @click="emit('download')">
    <span :id="labelId">{{ t(delivery?.status === 'error' ? 'desktop.update.retryDownload' : 'desktop.update.downloadInApp') }}</span>
  </NButton>
  <NButton v-else-if="!supported" :aria-labelledby="labelId" type="primary" :loading="pending" @click="emit('openRelease')">
    <span :id="labelId">{{ t('desktop.update.download') }}</span>
  </NButton>
</template>
