<script setup lang="ts">
import { ArrowUpRight20Regular } from '@vicons/fluent'
import { NAlert, NButton, NModal, NPopconfirm, NQrCode, NSwitch } from 'naive-ui'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopPairedDevices from './DesktopPairedDevices.vue'
import { usePrivateNetworkSettings } from './usePrivateNetworkSettings'

const { t, api, status, devices, pairing, busy, unavailable, seconds, qr, act, configure, cancelPairing, issuePairing, openingRelease, openMobileRelease } = usePrivateNetworkSettings()
const disabled = computed(() => busy.value || unavailable.value || !status.value)
</script>

<template>
  <div class="flex min-h-0 min-w-0 w-full max-w-[64rem] flex-1 flex-col gap-4 mx-auto px-[clamp(1rem,3cqw,2.8rem)] pt-[clamp(20px,3cqw,24px)] pb-6" data-testid="private-network-settings">
    <div class="flex flex-none flex-col gap-4">
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.devices.enable')" :description="t('desktop.settings.devices.description')" toggle>
          <NSwitch v-bind="controlAttrs" :value="status?.enabled ?? false" :disabled="disabled" :aria-disabled="disabled" :loading="busy" :round="false" @update:value="configure" />
        </DesktopSettingRow>
        <DesktopSettingRow v-slot="{ controlAttrs }" label="Lexora Android" :description="t('desktop.settings.devices.downloadDescription')" toggle>
          <NButton size="small" :aria-describedby="controlAttrs['aria-describedby']" :loading="openingRelease" @click="openMobileRelease">
            <template #icon>
              <DesktopIcon :component="ArrowUpRight20Regular" :size="15" />
            </template>
            {{ t('desktop.settings.devices.download') }}
          </NButton>
        </DesktopSettingRow>
      </DesktopSettingsGroup>
      <NAlert v-if="unavailable" type="warning" :show-icon="false">
        {{ t('desktop.settings.devices.unavailable') }}
      </NAlert>
      <NAlert v-else-if="status?.errorCode" type="warning" :show-icon="false">
        {{ t(`desktop.settings.devices.error.${status.errorCode}`) }}
      </NAlert>
    </div>
    <div class="flex flex-none flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 class="m-0 text-sm font-600 text-fg">
        {{ t('desktop.settings.devices.pairedTitle') }}
      </h2>
      <div class="flex flex-wrap items-center gap-2">
        <NPopconfirm v-if="status?.errorCode === 'TLS_IDENTITY_UNAVAILABLE'" @positive-click="act(() => api.resetIdentity({}))">
          <template #trigger>
            <NButton size="small" :disabled="disabled">
              {{ t('desktop.settings.devices.reset') }}
            </NButton>
          </template>
          {{ t('desktop.settings.devices.resetConfirm') }}
        </NPopconfirm>
        <NButton size="small" type="primary" :disabled="disabled || status?.state !== 'listening'" @click="issuePairing">
          {{ t('desktop.settings.devices.pair') }}
        </NButton>
      </div>
    </div>
    <DesktopPairedDevices v-if="!unavailable" :devices="devices" :loading="!status" :enabled="status?.state === 'listening'" :busy="busy" @revoke="deviceId => act(() => api.revoke({ deviceId }))" />
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
  </div>
</template>
