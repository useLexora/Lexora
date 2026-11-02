<script setup lang="ts">
import type { CodemodeMode, CodemodeWorkerLimit, RuntimePreferences } from '@buddy-shared/runtime/runtimePreferences'
import type { ApplicationSettingsProps } from '../app/typing'
import { DEFAULT_CODEMODE_WORKER_LIMIT } from '@buddy-shared/runtime/runtimePreferences'
import { NInputNumber, useMessage } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopRiskConfirmationDialog from '@/shared/ui/confirmation/DesktopRiskConfirmationDialog.vue'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'

type Field = 'codemode' | 'codemodeWorkerLimit' | 'codemodeOverflow'
type LimitMode = 'limited' | 'unlimited'
const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending, save } = useSettingMutation<Field>(patch => props.updateSettings(patch), () => message.error(t('desktop.settings.saveFailed')))
const confirming = shallowRef(false)
const pendingLimit = shallowRef<CodemodeWorkerLimit | null>(null)
const limit = computed(() => pendingLimit.value ?? props.config?.runtime.codemodeWorkerLimit ?? DEFAULT_CODEMODE_WORKER_LIMIT)
const limitMode = computed<LimitMode>(() => limit.value === 'unlimited' ? 'unlimited' : 'limited')
const count = computed(() => typeof limit.value === 'number' ? limit.value : DEFAULT_CODEMODE_WORKER_LIMIT)
const limitModes = computed(() => [
  { label: t('desktop.settings.runtime.codemodeLimited'), value: 'limited' as const },
  { label: t('desktop.settings.runtime.codemodeUnlimited'), value: 'unlimited' as const },
])
const codemodeOptions = computed(() => [
  { label: t('desktop.settings.runtime.codemodeOff'), value: 'off' as const },
  { label: t('desktop.settings.runtime.codemodeOn'), value: 'on' as const },
  { label: t('desktop.settings.runtime.codemodeOnly'), value: 'only' as const },
])
const description = computed(() => {
  const descriptions = {
    off: 'desktop.settings.runtime.codemodeOffDescription',
    on: 'desktop.settings.runtime.codemodeOnDescription',
    only: 'desktop.settings.runtime.codemodeOnlyDescription',
  } as const
  return `${t(descriptions[props.config?.runtime.codemode ?? 'on'])} ${t('desktop.settings.runtime.codemodeApplyNextRun')}`
})
const overflowModes = computed(() => [
  { label: t('desktop.settings.runtime.codemodeWait'), value: 'wait' as const },
  { label: t('desktop.settings.runtime.codemodeReject'), value: 'reject' as const },
])
const confirmation = computed(() => ({
  title: t('desktop.settings.runtime.codemodeUnlimitedTitle'),
  description: t('desktop.settings.runtime.codemodeUnlimitedDescription'),
  acknowledgement: t('desktop.settings.runtime.codemodeUnlimitedAcknowledgement'),
  confirmLabel: t('desktop.settings.runtime.codemodeUnlimitedConfirm'),
  cancelLabel: t('common.cancel'),
}))

async function updateLimit(value: CodemodeWorkerLimit) {
  if (pending.value.has('codemodeWorkerLimit') || value === props.config?.runtime.codemodeWorkerLimit)
    return
  pendingLimit.value = value
  try {
    await save('codemodeWorkerLimit', { runtime: { codemodeWorkerLimit: value } })
  }
  finally {
    pendingLimit.value = null
  }
}

function updateMode(value: LimitMode) {
  if (value === limitMode.value || pending.value.has('codemodeWorkerLimit'))
    return
  if (value === 'unlimited')
    confirming.value = true
  else
    void updateLimit(DEFAULT_CODEMODE_WORKER_LIMIT)
}

function updateCount(value: number | null) {
  if (value !== null)
    void updateLimit(value)
}

function updateOverflow(value: RuntimePreferences['codemodeOverflow']) {
  void save('codemodeOverflow', { runtime: { codemodeOverflow: value } })
}

function updateCodemode(value: CodemodeMode) {
  void save('codemode', { runtime: { codemode: value } })
}
</script>

<template>
  <template v-if="config">
    <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.runtime.codemode')" :description="description" toggle data-testid="codemode-setting">
      <DesktopSegmentedControl v-bind="controlAttrs" :model-value="config.runtime.codemode" :options="codemodeOptions" :disabled="pending.has('codemode')" @update:model-value="updateCodemode" />
    </DesktopSettingRow>
    <template v-if="config.runtime.codemode !== 'off'">
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.runtime.codemodeConcurrency')" :description="t('desktop.settings.runtime.codemodeConcurrencyDescription')" toggle data-testid="codemode-concurrency-setting">
        <DesktopSegmentedControl v-bind="controlAttrs" :model-value="limitMode" :options="limitModes" :disabled="pending.has('codemodeWorkerLimit')" @update:model-value="updateMode" />
      </DesktopSettingRow>
      <DesktopSettingRow v-if="limitMode === 'limited'" v-slot="{ controlAttrs }" :label="t('desktop.settings.runtime.codemodeWorkerLimit')" :description="t('desktop.settings.runtime.codemodeWorkerLimitDescription')" toggle data-testid="codemode-worker-limit-setting">
        <NInputNumber v-bind="controlAttrs" class="w-32" :value="count" :min="1" :max="Number.MAX_SAFE_INTEGER" :precision="0" :update-value-on-input="false" :disabled="pending.has('codemodeWorkerLimit')" @update:value="updateCount" />
      </DesktopSettingRow>
      <DesktopSettingRow v-if="limitMode === 'limited'" v-slot="{ controlAttrs }" :label="t('desktop.settings.runtime.codemodeOverflow')" :description="t('desktop.settings.runtime.codemodeOverflowDescription')" toggle data-testid="codemode-overflow-setting">
        <DesktopSegmentedControl v-bind="controlAttrs" :model-value="config.runtime.codemodeOverflow" :options="overflowModes" :disabled="pending.has('codemodeOverflow')" @update:model-value="updateOverflow" />
      </DesktopSettingRow>
    </template>
    <DesktopRiskConfirmationDialog v-model:show="confirming" class="desktop-codemode-confirmation" :text="confirmation" @confirm="updateLimit('unlimited')" />
  </template>
</template>
