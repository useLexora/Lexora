<script setup lang="ts">
import type { BuddyPermissionMode } from '@buddy-shared/permissions/permissionMode'
import type { RuntimePreferences } from '@buddy-shared/runtime/runtimePreferences'
import type { ApplicationSettingsProps } from '../app/typing'
import { BUDDY_PERMISSION_MODES } from '@buddy-shared/permissions/permissionMode'
import { DEFAULT_MODEL_RETRY_LIMIT } from '@buddy-shared/runtime/runtimePreferences'
import { NInputNumber, NSelect, NSwitch, useMessage } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopFullAccessConfirmationDialog } from '@/modules/prompt-input/ui'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'

import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

type RuntimeSettingField = 'cacheWarming' | 'codemode' | 'defaultPermissionMode' | 'modelRetryLimit'
type RetryMode = 0 | 'limited' | 'unlimited'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const fullAccessConfirmationText = computed(() => ({
  acknowledgement: t('desktop.settings.runtime.fullAccessDefaultAcknowledgement'),
  cancelLabel: t('common.cancel'),
  confirmLabel: t('desktop.settings.runtime.fullAccessDefaultConfirm'),
  description: t('desktop.settings.runtime.fullAccessDefaultDescription'),
  title: t('desktop.settings.runtime.fullAccessDefaultTitle'),
}))
const message = useMessage()
const retryModes = computed<{ label: string, value: RetryMode }[]>(() => [
  { label: t('desktop.settings.runtime.retryOff'), value: 0 },
  { label: t('desktop.settings.runtime.retryLimited'), value: 'limited' },
  { label: t('desktop.settings.runtime.retryUnlimited'), value: 'unlimited' },
])
const pendingRetryMode = shallowRef<RetryMode | null>(null)
const retryMode = computed<RetryMode>(() => {
  if (pendingRetryMode.value !== null)
    return pendingRetryMode.value
  const limit = props.config?.runtime.modelRetryLimit
  return limit === 0 || limit === 'unlimited' ? limit : 'limited'
})
const retryCount = computed(() => {
  const limit = props.config?.runtime.modelRetryLimit
  return typeof limit === 'number' && limit > 0 ? limit : DEFAULT_MODEL_RETRY_LIMIT
})
const { pending: pendingFields, save } = useSettingMutation<RuntimeSettingField>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const fullAccessConfirmationOpen = shallowRef(false)
const cacheWarmingModes = computed(() => [
  { label: t('desktop.settings.runtime.cacheWarmingOff'), value: 'off' },
  { label: t('desktop.settings.runtime.cacheWarmingStreaming'), value: 'streaming' },
])
const permissionModeLabelKeys: Record<BuddyPermissionMode, 'desktop.chat.executionProfileReadOnly' | 'desktop.chat.permissionModeManual' | 'desktop.chat.permissionModePolicy' | 'desktop.chat.executionProfileFull'> = {
  full_access: 'desktop.chat.executionProfileFull',
  manual_approval: 'desktop.chat.permissionModeManual',
  policy_approval: 'desktop.chat.permissionModePolicy',
  read_only: 'desktop.chat.executionProfileReadOnly',
}
const permissionModes = computed(() => BUDDY_PERMISSION_MODES.map(value => ({
  label: t(permissionModeLabelKeys[value]),
  value,
})))

function selectDefaultPermissionMode(permissionMode: BuddyPermissionMode) {
  if (permissionMode === props.config?.desktop.chat.permissionMode)
    return
  if (permissionMode === 'full_access') {
    fullAccessConfirmationOpen.value = true
    return
  }
  void save('defaultPermissionMode', { desktop: { chat: { permissionMode } } })
}

function confirmFullAccess() {
  void save('defaultPermissionMode', { desktop: { chat: { permissionMode: 'full_access' } } })
}

async function updateRetryMode(mode: RetryMode) {
  if (pendingFields.value.has('modelRetryLimit') || mode === retryMode.value)
    return
  pendingRetryMode.value = mode
  try {
    await save('modelRetryLimit', { runtime: { modelRetryLimit: mode === 'limited' ? DEFAULT_MODEL_RETRY_LIMIT : mode } })
  }
  finally {
    pendingRetryMode.value = null
  }
}

function updateRetryCount(count: number | null) {
  if (count === null || count === props.config?.runtime.modelRetryLimit)
    return
  void save('modelRetryLimit', { runtime: { modelRetryLimit: count } })
}

function updateCacheWarming(cacheWarming: RuntimePreferences['cacheWarming']) {
  void save('cacheWarming', { runtime: { cacheWarming } })
}

function updateCodemode(codemode: boolean) {
  void save('codemode', { runtime: { codemode } })
}
</script>

<template>
  <section v-if="config" class="runtime-settings grid gap-[1.8rem] [container-type:inline-size] [--setting-row-height:0px]">
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.settings.runtime.modelRequests') }}
      </h2>
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.runtime.modelRetry')" :description="t('desktop.settings.runtime.modelRetryDescription')" toggle data-testid="model-retry-limit-setting">
          <DesktopSegmentedControl v-bind="controlAttrs" :model-value="retryMode" :options="retryModes" :disabled="pendingFields.has('modelRetryLimit')" @update:model-value="updateRetryMode" />
        </DesktopSettingRow>
        <DesktopSettingRow v-if="retryMode === 'limited'" v-slot="{ controlAttrs }" :label="t('desktop.settings.runtime.modelRetryLimit')" :description="t('desktop.settings.runtime.retryCountDescription')" toggle data-testid="model-retry-count-setting">
          <NInputNumber v-bind="controlAttrs" class="w-32" :value="retryCount" :min="1" :max="Number.MAX_SAFE_INTEGER" :precision="0" :update-value-on-input="false" :disabled="pendingFields.has('modelRetryLimit')" @update:value="updateRetryCount">
            <template #suffix>
              {{ t('desktop.settings.runtime.retryCountUnit') }}
            </template>
          </NInputNumber>
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.settings.runtime.toolExecution') }}
      </h2>
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.runtime.codemode')" :description="t('desktop.settings.runtime.codemodeDescription')" toggle data-testid="codemode-setting">
          <NSwitch v-bind="controlAttrs" :round="false" :value="config.runtime.codemode" :loading="pendingFields.has('codemode')" :disabled="pendingFields.has('codemode')" :aria-disabled="pendingFields.has('codemode')" @update:value="updateCodemode" />
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.settings.runtime.taskPermissions') }}
      </h2>
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.runtime.defaultPermissionMode')" :description="t('desktop.settings.runtime.defaultPermissionModeDescription')" data-testid="default-permission-mode-setting">
          <NSelect v-bind="controlAttrs" :value="config.desktop.chat.permissionMode" :options="permissionModes" :loading="pendingFields.has('defaultPermissionMode')" :disabled="pendingFields.has('defaultPermissionMode')" @update:value="selectDefaultPermissionMode" />
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.settings.runtime.context') }}
      </h2>
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.runtime.cacheWarming')" :description="t('desktop.settings.runtime.cacheWarmingDescription')" data-testid="cache-warming-setting">
          <NSelect v-bind="controlAttrs" :value="config.runtime.cacheWarming" :options="cacheWarmingModes" :loading="pendingFields.has('cacheWarming')" :disabled="pendingFields.has('cacheWarming')" @update:value="updateCacheWarming" />
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
    <DesktopFullAccessConfirmationDialog v-model:show="fullAccessConfirmationOpen" :text="fullAccessConfirmationText" @confirm="confirmFullAccess" />
  </section>
</template>
