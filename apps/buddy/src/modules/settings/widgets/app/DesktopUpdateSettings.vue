<script setup lang="ts">
import type { DesktopUpdateCapabilities, DesktopUpdateChannel } from '@buddy-electron/shared/desktopUpdates'
import type { ApplicationSettingsProps } from './typing'
import { NButton, NSpin, NTag, NTooltip, useDialog, useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useDesktopUpdatesContext } from '@/modules/updates'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopApplicationToggle from './DesktopApplicationToggle.vue'
import DesktopUpdateCacheSettings from './DesktopUpdateCacheSettings.vue'

const props = defineProps<ApplicationSettingsProps & { capabilities?: DesktopUpdateCapabilities, currentVersion?: string }>()
const { t } = useBuddyI18n(() => props.language)
const updates = useDesktopUpdatesContext()
const message = useMessage()
const dialog = useDialog()
let disposed = false
let confirmation: ReturnType<typeof dialog.warning> | null = null
const { pending, save } = useSettingMutation<'updateChannel'>(
  patch => props.updateSettings(patch),
  () => {
    if (!disposed)
      message.error(t('desktop.settings.saveFailed'))
  },
)
const channel = computed(() => props.config?.desktop.updateChannel ?? 'stable')
const installing = computed(() => updates.state.value?.delivery?.status === 'installing')
const channelPending = computed(() => pending.value.has('updateChannel'))
const channelOptions = computed(() => [
  { label: t('desktop.update.channelStable'), value: 'stable' as const },
  { label: t('desktop.update.channelBeta'), value: 'beta' as const },
])
const channelDescription = computed(() => t(channel.value === 'beta'
  ? 'desktop.update.channelBetaDescription'
  : /-beta\.\d+$/.test(props.currentVersion ?? '') ? 'desktop.update.channelStableFromBeta' : 'desktop.update.channelStableDescription'))
watch([channelPending, installing], ([saving, installing]) => {
  if (!confirmation)
    return
  confirmation.loading = saving
  confirmation.positiveButtonProps = { disabled: saving || installing }
  confirmation.negativeButtonProps = { disabled: saving }
  confirmation.closable = !saving
  confirmation.maskClosable = !saving
  confirmation.closeOnEsc = !saving
})
onScopeDispose(() => {
  disposed = true
  confirmation?.destroy()
})
const restoring = shallowRef(false)
const ignoredVersion = computed(() => updates.state.value?.ignoredVersion ?? null)
const downloadDirectory = computed(() => updates.state.value?.downloadDirectory ?? null)
const checkedAt = computed(() => {
  const timestamp = updates.state.value?.lastSuccessfulCheckAt
  if (updates.state.value?.checking)
    return t('desktop.update.checking')
  return timestamp == null ? t('desktop.update.neverChecked') : t('desktop.update.checkedAt', { time: new Intl.DateTimeFormat(props.language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp) })
})
const checkedAtDescription = computed(() => {
  const timestamp = updates.state.value?.lastSuccessfulCheckAt
  return timestamp == null ? t('desktop.update.neverChecked') : t('desktop.update.successfulCheckAt', { time: new Intl.DateTimeFormat(props.language, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp) })
})

function selectChannel(updateChannel: DesktopUpdateChannel) {
  if (!props.config || disposed || installing.value || channelPending.value || confirmation || updateChannel === channel.value)
    return
  if (updateChannel === 'stable') {
    void save('updateChannel', { desktop: { updateChannel } })
    return
  }
  confirmation = dialog.warning({
    title: t('desktop.update.joinBetaTitle'),
    content: t('desktop.update.joinBetaDescription'),
    positiveText: t('desktop.update.joinBeta'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      if (disposed || installing.value || channelPending.value)
        return false
      return save('updateChannel', { desktop: { updateChannel: 'beta' } })
    },
    onAfterLeave: () => { confirmation = null },
  })
}

async function restore() {
  if (restoring.value || !ignoredVersion.value)
    return
  restoring.value = true
  try {
    await updates.restore(ignoredVersion.value)
  }
  catch {
    message.error(t('desktop.update.restoreFailed'))
  }
  finally {
    restoring.value = false
  }
}

async function retryCheck() {
  try {
    await updates.check()
  }
  catch {
    message.error(t('desktop.update.failed'))
  }
}
</script>

<template>
  <section class="desktop-update-settings grid gap-[0.8rem]">
    <h3 class="m-0 text-fg text-[0.85rem] font-600">
      {{ t('desktop.update.settings') }}
    </h3>
    <DesktopSettingsGroup class="[container-type:inline-size] [--setting-row-py:0.9rem] [--setting-control-min:0px] [--setting-control-max:max-content]">
      <DesktopSettingRow v-if="config" :label="t('desktop.update.channel')" :description="channelDescription" :disabled="installing" toggle data-testid="update-channel-setting">
        <template #hint>
          <small v-if="installing" class="text-muted text-[0.7rem] leading-[1.5]" role="status">{{ t('desktop.update.channelInstalling') }}</small>
        </template>
        <template #default="{ controlAttrs }">
          <DesktopSegmentedControl
            v-bind="controlAttrs" :options="channelOptions" :model-value="channel" :disabled="installing || channelPending" :aria-disabled="installing || channelPending"
            @update:model-value="selectChannel"
          />
          <NSpin v-if="channelPending" size="small" />
        </template>
      </DesktopSettingRow>
      <DesktopApplicationToggle
        field="updateNotificationsEnabled"
        :label="t('desktop.update.autoCheck')"
        :description="t('desktop.update.autoCheckDescription')"
        :disabled-reason="capabilities?.automaticCheck ? undefined : t('desktop.update.autoCheckUnavailable')"
        :config="config"
        :error="error"
        :language="language"
        :update-settings="updateSettings"
      >
        <template #labelExtra>
          <NTooltip>
            <template #trigger>
              <NTag size="small" :bordered="false" role="status" data-testid="update-check-status">
                {{ checkedAt }}
              </NTag>
            </template>
            {{ checkedAtDescription }}
          </NTooltip>
        </template>
        <template v-if="updates.state.value?.checkFailed && !updates.state.value.checking" #hint>
          <small class="text-muted text-[0.7rem] leading-[1.5]" role="status">
            {{ t('desktop.update.cachedResultDescription') }}
            <NButton text size="tiny" type="primary" @click="retryCheck">{{ t('desktop.update.retryCheck') }}</NButton>
          </small>
        </template>
      </DesktopApplicationToggle>
      <DesktopApplicationToggle
        field="autoDownloadUpdates"
        :label="t('desktop.update.autoDownload')"
        :description="t(config?.desktop.updateNotificationsEnabled ? 'desktop.update.autoDownloadDescription' : 'desktop.update.autoDownloadPaused')"
        :disabled-reason="capabilities?.download ? undefined : t('desktop.update.autoDownloadUnavailable')"
        :config="config"
        :error="error"
        :language="language"
        :update-settings="updateSettings"
      />
      <DesktopSettingRow
        v-if="ignoredVersion"
        v-slot="{ controlAttrs }"
        :label="t('desktop.update.skippedVersion', { version: ignoredVersion })"
        :description="t('desktop.update.skipDescription')"
        toggle
      >
        <NButton :aria-describedby="controlAttrs['aria-describedby']" size="small" :loading="restoring" :disabled="restoring" @click="restore">
          {{ t('desktop.update.restore') }}
        </NButton>
      </DesktopSettingRow>
      <DesktopUpdateCacheSettings v-if="downloadDirectory" :language="language" :directory="downloadDirectory" />
    </DesktopSettingsGroup>
  </section>
</template>
