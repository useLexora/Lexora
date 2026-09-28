<script setup lang="ts">
import type { LexoraConfigPatch } from '@buddy-electron/shared/desktopApi'
import type { BuddyPermissionMode } from '@buddy-shared/permissions/permissionMode'
import type { RuntimePreferences } from '@buddy-shared/runtime/runtimePreferences'
import type { ApplicationSettingsProps } from '../app/typing'
import { BUDDY_PERMISSION_MODES } from '@buddy-shared/permissions/permissionMode'
import { NSelect, useMessage } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopFullAccessConfirmationDialog } from '@/modules/prompt-input/ui'

type RuntimeSettingField = 'cacheWarming' | 'defaultPermissionMode'

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
const defaultPermissionLabelId = useId()
const defaultPermissionDescriptionId = useId()
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

function updateCacheWarming(cacheWarming: RuntimePreferences['cacheWarming']) {
  void save('cacheWarming', { runtime: { cacheWarming } })
}
</script>

<template>
  <section v-if="config" class="runtime-settings">
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

.runtime-settings__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(10rem, 19rem);
  align-items: center;
  gap: 2rem;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 0.65rem;
  padding: 0.75rem 0.9rem;
  background: var(--buddy-surface-base);
}

.runtime-settings__copy,
.runtime-settings__control {
  display: grid;
  gap: 0.25rem;
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
}
</style>
