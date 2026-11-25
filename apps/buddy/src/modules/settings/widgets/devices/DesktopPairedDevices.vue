<script setup lang="ts">
import type { PairedDevice } from '@buddy-shared/privateNetwork/management'
import { Phone20Regular } from '@vicons/fluent'
import { NButton, NEmpty, NModal, NPopconfirm, NScrollbar, NSpin, NTag } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useSettingsContext } from '../../settingsContext'

const props = defineProps<{ devices: PairedDevice[], loading: boolean, enabled: boolean, busy: boolean }>()
defineEmits<{ revoke: [deviceId: string] }>()
const { applicationSettings: { language } } = useSettingsContext()
const { t } = useBuddyI18n(language)
const detailTitleId = useId()
const selectedId = shallowRef<string | null>(null)
const selected = computed(() => props.devices.find(device => device.deviceId === selectedId.value))
const dateFormat = computed(() => new Intl.DateTimeFormat(language.value, { dateStyle: 'medium', timeStyle: 'short' }))

function name(device: PairedDevice) {
  const model = device.profile?.model ?? device.name
  const manufacturer = device.profile?.manufacturer
  if (!manufacturer || model.toLowerCase().startsWith(manufacturer.toLowerCase()))
    return model
  return `${manufacturer[0]!.toUpperCase()}${manufacturer.slice(1)} ${model}`
}

function system(device: PairedDevice) {
  if (!device.profile)
    return t('desktop.settings.devices.unknownPlatform')
  const platform = device.profile.platform === 'android' ? 'Android' : 'iOS'
  return device.profile.osVersion ? `${platform} ${device.profile.osVersion}` : platform
}

const detailFields = computed(() => {
  const device = selected.value
  if (!device)
    return []
  const unknown = t('desktop.settings.devices.unknownValue')
  return [
    { key: 'manufacturer', value: device.profile?.manufacturer ?? unknown },
    { key: 'model', value: device.profile?.model ?? device.name },
    { key: 'system', value: system(device) },
    { key: 'appVersion', value: device.profile?.appVersion ?? unknown },
    { key: 'pairedAt', value: device.confirmedAt ? dateFormat.value.format(new Date(device.confirmedAt)) : unknown },
    { key: 'id', value: device.deviceId },
  ] as const
})
</script>

<template>
  <div v-if="loading || !devices.length" class="flex min-h-48 flex-1 items-center justify-center p-4" data-testid="paired-devices-empty-area">
    <NSpin v-if="loading" size="small" />
    <NEmpty v-else :description="t('desktop.settings.devices.empty')" data-testid="paired-devices-empty">
      <template #extra>
        <p class="m-0 text-xs text-muted">
          {{ t(enabled ? 'desktop.settings.devices.emptyReady' : 'desktop.settings.devices.emptyDisabled') }}
        </p>
      </template>
    </NEmpty>
  </div>
  <NScrollbar v-else class="min-h-0 flex-1">
    <ul class="m-0 grid list-none gap-3 p-0" data-testid="paired-devices-list">
      <li v-for="device in devices" :key="device.deviceId" class="flex min-w-0 flex-wrap items-center justify-between gap-3 border border-solid border-border rounded-3 px-4 py-3">
        <div class="flex min-w-0 items-start gap-3">
          <span class="grid h-9 w-9 flex-none place-items-center rounded-[var(--buddy-radius-micro)] bg-subtle text-muted" aria-hidden="true">
            <DesktopIcon :component="Phone20Regular" :size="19" />
          </span>
          <div class="grid min-w-0 gap-1">
            <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <strong class="break-all text-sm font-600">{{ name(device) }}</strong>
              <NTag size="small" :bordered="false" :type="device.state === 'active' ? 'success' : device.state === 'pending' ? 'warning' : 'default'">
                {{ t(`desktop.settings.devices.state.${device.state}`) }}
              </NTag>
            </div>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
              <span class="break-all">{{ system(device) }}</span><span aria-hidden="true">·</span>
              <span class="font-mono">ID …{{ device.deviceId.slice(-6) }}</span><span aria-hidden="true">·</span>
              <span v-if="device.lastSeenAt">{{ t('desktop.settings.devices.lastSeen') }} <time :datetime="device.lastSeenAt">{{ dateFormat.format(new Date(device.lastSeenAt)) }}</time></span>
              <span v-else>{{ t('desktop.settings.devices.neverSeen') }}</span>
            </div>
          </div>
        </div>
        <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
          <NButton size="small" quaternary @click="selectedId = device.deviceId">
            {{ t('desktop.settings.devices.details') }}
          </NButton>
          <NPopconfirm v-if="device.state === 'active' || device.state === 'pending'" @positive-click="$emit('revoke', device.deviceId)">
            <template #trigger>
              <NButton size="small" :disabled="busy">
                {{ t('desktop.settings.devices.revoke') }}
              </NButton>
            </template>
            {{ t('desktop.settings.devices.revokeConfirm') }}
          </NPopconfirm>
        </div>
      </li>
    </ul>
  </NScrollbar>
  <NModal :show="!!selected" preset="card" :aria-labelledby="detailTitleId" class="w-[min(26rem,calc(100vw-2rem))]" @update:show="show => { if (!show) selectedId = null }">
    <template #header>
      <span :id="detailTitleId">{{ t('desktop.settings.devices.details') }}</span>
    </template>
    <template v-if="selected">
      <h3 class="m-0 break-all text-sm font-600">
        {{ name(selected) }}
      </h3>
      <p v-if="!selected.profile" class="mt-2 mb-0 text-xs text-muted">
        {{ t('desktop.settings.devices.noProfile') }}
      </p>
      <dl class="mt-3 mb-0 grid gap-2 text-xs">
        <div v-for="field in detailFields" :key="field.key" class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 border-t border-t-solid border-border pt-2">
          <dt class="text-muted">
            {{ t(`desktop.settings.devices.${field.key}`) }}
          </dt>
          <dd class="m-0 break-all" :class="{ 'font-mono': field.key === 'id' }">
            {{ field.value }}
          </dd>
        </div>
      </dl>
    </template>
  </NModal>
</template>
