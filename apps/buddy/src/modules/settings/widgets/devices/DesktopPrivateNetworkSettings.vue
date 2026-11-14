<script setup lang="ts">
import { NAlert, NButton, NInput, NInputNumber, NModal, NPopconfirm, NQrCode, NSwitch } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopPairedDevices from './DesktopPairedDevices.vue'
import { usePrivateNetworkSettings } from './usePrivateNetworkSettings'

const { t, api, status, devices, pairing, busy, unavailable, seconds, qr, act, configure, cancelPairing, issuePairing } = usePrivateNetworkSettings()
const disabled = computed(() => busy.value || unavailable.value || !status.value)
const optionsOpen = shallowRef(false)
const address = shallowRef('')
const port = shallowRef<number | null>(19443)
function openOptions() {
  address.value = status.value?.bindAddress ?? ''
  port.value = status.value?.port ?? 19443
  optionsOpen.value = true
}
async function saveOptions() {
  if (!port.value)
    return
  const saved = await act(async () => {
    status.value = await api.configure({ enabled: false, bindAddress: address.value.trim(), port: port.value! })
  })
  if (saved)
    optionsOpen.value = false
}
</script>

<template>
  <div class="flex min-h-0 min-w-0 w-full max-w-[64rem] flex-1 flex-col gap-4 mx-auto px-[clamp(1rem,3cqw,2.8rem)] pt-[clamp(20px,3cqw,24px)] pb-6" data-testid="private-network-settings">
    <div class="flex flex-none flex-col gap-4">
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.devices.enable')" :description="t('desktop.settings.devices.description')" toggle>
          <NSwitch v-bind="controlAttrs" :value="status?.enabled ?? false" :disabled="disabled" :aria-disabled="disabled" :loading="busy" :round="false" @update:value="configure" />
        </DesktopSettingRow>
      </DesktopSettingsGroup>
      <NAlert v-if="unavailable" type="warning" :show-icon="false">
        {{ t('desktop.settings.devices.unavailable') }}
      </NAlert>
      <NAlert v-else-if="status?.errorCode" type="warning" :show-icon="false">
        {{ t(`desktop.settings.devices.error.${status.errorCode}`) }}
      </NAlert>
    </div>
    <div class="flex flex-none flex-wrap items-center justify-end gap-2">
      <NButton size="small" :disabled="disabled" @click="openOptions">
        {{ t('desktop.settings.devices.options') }}
      </NButton>
      <NButton size="small" type="primary" :disabled="disabled || status?.state !== 'listening'" @click="issuePairing">
        {{ t('desktop.settings.devices.pair') }}
      </NButton>
    </div>
    <DesktopPairedDevices :devices="devices" :loading="!status && !unavailable" :unavailable="unavailable" :enabled="status?.state === 'listening'" :busy="busy" @revoke="deviceId => act(() => api.revoke({ deviceId }))" />
    <NModal :show="!!pairing" preset="card" :title="t('desktop.settings.devices.pair')" class="w-[min(24rem,calc(100vw-2rem))]" @update:show="show => { if (!show) act(cancelPairing) }">
      <div class="flex flex-col items-center gap-4" data-testid="device-pairing-code">
        <NQrCode v-if="qr" class="box-content" :value="qr" :size="256" :padding="16" error-correction-level="M" />
        <p class="m-0 text-center text-sm text-muted">
          {{ seconds ? t('desktop.settings.devices.expires', { seconds }) : t('desktop.settings.devices.expired') }}
        </p>
        <NButton v-if="!qr" :disabled="busy" @click="issuePairing">
          {{ t('desktop.settings.devices.pair') }}
        </NButton>
      </div>
    </NModal>
    <NModal v-model:show="optionsOpen" preset="card" :title="t('desktop.settings.devices.options')" class="w-[min(36rem,calc(100vw-2rem))]">
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.devices.address')" :description="t('desktop.settings.devices.addressDescription')">
        <NInput v-model:value="address" v-bind="controlAttrs" :disabled="busy || status?.enabled" :placeholder="t('desktop.settings.devices.automatic')" />
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.devices.port')">
        <NInputNumber v-model:value="port" v-bind="controlAttrs" :min="1" :max="65535" :precision="0" :show-button="false" :disabled="busy || status?.enabled" />
      </DesktopSettingRow>
      <template #footer>
        <div class="flex flex-wrap justify-between gap-3">
          <NPopconfirm @positive-click="act(() => api.resetIdentity({}))">
            <template #trigger>
              <NButton :disabled="disabled" quaternary>
                {{ t('desktop.settings.devices.reset') }}
              </NButton>
            </template>
            {{ t('desktop.settings.devices.resetConfirm') }}
          </NPopconfirm>
          <NButton type="primary" :disabled="disabled || status?.enabled || !port" @click="saveOptions">
            {{ t('desktop.settings.devices.save') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>
