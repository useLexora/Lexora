<script setup lang="ts">
import type { LexoraConfigPatch } from '@buddy-electron/shared/desktopApi'
import type { BuddyPermissionMode } from '@buddy-shared/permissions/permissionMode'
import type { RuntimePreferences } from '@buddy-shared/runtime/runtimePreferences'
import type { ApplicationSettingsProps } from '../app/typing'
import { BUDDY_PERMISSION_MODES } from '@buddy-shared/permissions/permissionMode'
import { DEFAULT_MODEL_RETRY_LIMIT } from '@buddy-shared/runtime/runtimePreferences'
import { NInputNumber, NSelect, NSwitch, useMessage } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopFullAccessConfirmationDialog } from '@/modules/prompt-input/ui'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'

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
const cacheWarmingLabelId = useId()
const cacheWarmingDescriptionId = useId()
const codemodeLabelId = useId()
const codemodeDescriptionId = useId()
const defaultPermissionLabelId = useId()
const defaultPermissionDescriptionId = useId()
const retryLabelId = useId()
const retryDescriptionId = useId()
const retryCountLabelId = useId()
const retryCountDescriptionId = useId()
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
const pendingFields = shallowRef<ReadonlySet<RuntimeSettingField>>(new Set())
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

async function save(field: RuntimeSettingField, patch: LexoraConfigPatch) {
  if (pendingFields.value.has(field))
    return
  pendingFields.value = new Set([...pendingFields.value, field])
  try {
    if (!await props.updateSettings(patch))
      message.error(t('desktop.settings.saveFailed'))
  }
  finally {
    pendingFields.value = new Set([...pendingFields.value].filter(item => item !== field))
  }
}

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
  <section v-if="config" class="runtime-settings">
    <section class="runtime-settings__section">
      <h2>{{ t('desktop.settings.runtime.modelRequests') }}</h2>
      <div class="runtime-settings__group">
        <div class="runtime-settings__row" data-testid="model-retry-limit-setting">
          <div class="runtime-settings__copy">
            <strong :id="retryLabelId">{{ t('desktop.settings.runtime.modelRetry') }}</strong>
            <small :id="retryDescriptionId">{{ t('desktop.settings.runtime.modelRetryDescription') }}</small>
          </div>
          <DesktopSegmentedControl
            class="runtime-settings__retry-modes"
            :aria-labelledby="retryLabelId"
            :aria-describedby="retryDescriptionId"
            :model-value="retryMode"
            :options="retryModes"
            :disabled="pendingFields.has('modelRetryLimit')"
            @update:model-value="updateRetryMode"
          />
        </div>
        <div v-if="retryMode === 'limited'" class="runtime-settings__row" data-testid="model-retry-count-setting">
          <div class="runtime-settings__copy">
            <strong :id="retryCountLabelId">{{ t('desktop.settings.runtime.modelRetryLimit') }}</strong>
            <small :id="retryCountDescriptionId">{{ t('desktop.settings.runtime.retryCountDescription') }}</small>
          </div>
          <div class="runtime-settings__control runtime-settings__retry-count">
            <NInputNumber
              :aria-labelledby="retryCountLabelId"
              :aria-describedby="retryCountDescriptionId"
              :value="retryCount"
              :min="1"
              :max="Number.MAX_SAFE_INTEGER"
              :precision="0"
              :update-value-on-input="false"
              :disabled="pendingFields.has('modelRetryLimit')"
              @update:value="updateRetryCount"
            >
              <template #suffix>
                {{ t('desktop.settings.runtime.retryCountUnit') }}
              </template>
            </NInputNumber>
          </div>
        </div>
      </div>
    </section>
    <section class="runtime-settings__section">
      <h2>{{ t('desktop.settings.runtime.toolExecution') }}</h2>
      <div class="runtime-settings__row" data-testid="codemode-setting">
        <div class="runtime-settings__copy">
          <strong :id="codemodeLabelId">{{ t('desktop.settings.runtime.codemode') }}</strong>
          <small :id="codemodeDescriptionId">{{ t('desktop.settings.runtime.codemodeDescription') }}</small>
        </div>
        <NSwitch
          class="runtime-settings__toggle"
          :round="false"
          :aria-labelledby="codemodeLabelId"
          :aria-describedby="codemodeDescriptionId"
          :value="config.runtime.codemode"
          :loading="pendingFields.has('codemode')"
          :disabled="pendingFields.has('codemode')"
          @update:value="updateCodemode"
        />
      </div>
    </section>
    <section class="runtime-settings__section">
      <h2>{{ t('desktop.settings.runtime.taskPermissions') }}</h2>
      <div class="runtime-settings__row" data-testid="default-permission-mode-setting">
        <div class="runtime-settings__copy">
          <strong :id="defaultPermissionLabelId">{{ t('desktop.settings.runtime.defaultPermissionMode') }}</strong>
          <small :id="defaultPermissionDescriptionId">{{ t('desktop.settings.runtime.defaultPermissionModeDescription') }}</small>
        </div>
        <div class="runtime-settings__control">
          <NSelect
            :aria-labelledby="defaultPermissionLabelId"
            :aria-describedby="defaultPermissionDescriptionId"
            :value="config.desktop.chat.permissionMode"
            :options="permissionModes"
            :loading="pendingFields.has('defaultPermissionMode')"
            :disabled="pendingFields.has('defaultPermissionMode')"
            @update:value="selectDefaultPermissionMode"
          />
        </div>
      </div>
    </section>
    <section class="runtime-settings__section">
      <h2>{{ t('desktop.settings.runtime.context') }}</h2>
      <div class="runtime-settings__row" data-testid="cache-warming-setting">
        <div class="runtime-settings__copy">
          <strong :id="cacheWarmingLabelId">{{ t('desktop.settings.runtime.cacheWarming') }}</strong>
          <small :id="cacheWarmingDescriptionId">{{ t('desktop.settings.runtime.cacheWarmingDescription') }}</small>
        </div>
        <div class="runtime-settings__control">
          <NSelect
            :aria-labelledby="cacheWarmingLabelId"
            :aria-describedby="cacheWarmingDescriptionId"
            :value="config.runtime.cacheWarming"
            :options="cacheWarmingModes"
            :loading="pendingFields.has('cacheWarming')"
            :disabled="pendingFields.has('cacheWarming')"
            @update:value="updateCacheWarming"
          />
        </div>
      </div>
    </section>
    <DesktopFullAccessConfirmationDialog
      v-model:show="fullAccessConfirmationOpen"
      :text="fullAccessConfirmationText"
      @confirm="confirmFullAccess"
    />
  </section>
</template>

<style scoped>
.runtime-settings {
  display: grid;
  gap: 1.8rem;
  container-type: inline-size;
}

.runtime-settings__section {
  display: grid;
  gap: 0.8rem;
}

.runtime-settings h2 {
  margin: 0;
  font-size: 0.92rem;
}

.runtime-settings__group,
.runtime-settings__section > .runtime-settings__row {
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 0.65rem;
  background: var(--buddy-surface-base);
}

.runtime-settings__group {
  overflow: hidden;
}

.runtime-settings__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(10rem, 19rem);
  align-items: center;
  gap: 2rem;
  padding: 0.75rem 0.9rem;
}

.runtime-settings__row + .runtime-settings__row {
  border-top: 1px solid var(--buddy-border-subtle);
}

.runtime-settings__copy,
.runtime-settings__control {
  display: grid;
  gap: 0.25rem;
}

.runtime-settings__retry-modes {
  justify-self: end;
}

.runtime-settings__toggle {
  justify-self: end;
}

.runtime-settings__retry-count {
  width: 8rem;
  justify-self: end;
}

.runtime-settings strong {
  color: var(--buddy-text-primary);
  font-size: 0.8rem;
  font-weight: 600;
}

.runtime-settings small {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
  line-height: 1.5;
}

@container (max-width: 560px) {
  .runtime-settings__row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.7rem;
  }

  .runtime-settings__retry-modes,
  .runtime-settings__retry-count,
  .runtime-settings__toggle {
    justify-self: start;
  }
}
</style>
