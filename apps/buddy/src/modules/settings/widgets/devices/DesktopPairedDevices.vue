<script setup lang="ts">
import type { PairedDevice } from '@buddy-shared/privateNetwork/management'
import { NButton, NEmpty, NPopconfirm, NScrollbar, NSpin, NTag } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSettingsContext } from '../../settingsContext'

defineProps<{ devices: PairedDevice[], loading: boolean, unavailable: boolean, enabled: boolean, busy: boolean }>()
defineEmits<{ revoke: [deviceId: string] }>()
const { applicationSettings: { language } } = useSettingsContext()
const { t } = useBuddyI18n(language)
</script>

<template>
  <div v-if="loading || unavailable || !devices.length" class="flex min-h-48 flex-1 items-center justify-center p-4" data-testid="paired-devices-empty-area">
    <NSpin v-if="loading" size="small" />
    <NEmpty v-else :description="t(unavailable ? 'desktop.settings.devices.unavailable' : 'desktop.settings.devices.empty')" data-testid="paired-devices-empty">
      <template v-if="!unavailable" #extra>
        <p class="m-0 text-xs text-muted">
          {{ t(enabled ? 'desktop.settings.devices.emptyReady' : 'desktop.settings.devices.emptyDisabled') }}
        </p>
      </template>
    </NEmpty>
  </div>
  <NScrollbar v-else class="min-h-0 flex-1">
    <ul class="m-0 grid list-none gap-4 p-0" data-testid="paired-devices-list">
      <li v-for="device in devices" :key="device.deviceId" class="flex flex-wrap items-center justify-between gap-3 min-w-0 border border-solid border-border rounded-3 px-[1.2rem] py-[1.1rem]">
        <div class="flex min-w-0 flex-wrap items-center gap-3">
          <strong class="break-words text-[0.95rem] font-600">{{ device.name }}</strong>
          <NTag size="small" :bordered="false" :type="device.state === 'active' ? 'success' : device.state === 'pending' ? 'warning' : 'default'">
            {{ t(`desktop.settings.devices.state.${device.state}`) }}
          </NTag>
        </div>
        <NPopconfirm v-if="device.state === 'active' || device.state === 'pending'" @positive-click="$emit('revoke', device.deviceId)">
          <template #trigger>
            <NButton size="small" :disabled="busy">
              {{ t('desktop.settings.devices.revoke') }}
            </NButton>
          </template>
          {{ t('desktop.settings.devices.revokeConfirm') }}
        </NPopconfirm>
      </li>
    </ul>
  </NScrollbar>
</template>
