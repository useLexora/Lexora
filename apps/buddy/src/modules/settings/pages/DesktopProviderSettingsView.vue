<script setup lang="ts">
import { NButton, NPopconfirm, NSwitch, NTooltip } from 'naive-ui'
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopProviderAddDialog, DesktopProviderAuthDialog, DesktopProviderDetail } from '@/modules/models/ui'
import DesktopSettingsPageLayout from '@/modules/settings/layouts/DesktopSettingsPageLayout.vue'
import { useSettingsContext } from '@/modules/settings/settingsContext'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  providerId: string
}>()

const router = useRouter()
const { providerSettings, ready } = useSettingsContext()
const { t } = useBuddyI18n(providerSettings.language)
const showAddDialog = shallowRef(false)
const provider = computed(() => providerSettings.providers.value.find(
  item => item.id === props.providerId,
) ?? null)
const providerSummary = computed(() => {
  const value = provider.value
  return value ? [value.builtinProviderId ?? value.id, value.description].filter(Boolean).join(' | ') : ''
})
const authProviderName = computed(() => providerSettings.providers.value.find(
  item => item.id === providerSettings.authChallenge.value?.providerId,
)?.displayName ?? null)
const removeDisabled = computed(() => {
  const value = provider.value
  return !value || value.activeRunCount > 0 || providerSettings.mutatingProviderId.value === value.id
})
watch(
  [() => props.providerId, provider],
  async (_providerId, _previousProviderId, onCleanup) => {
    let active = true
    onCleanup(() => active = false)
    await ready
    if (active && !provider.value)
      await router.replace(desktopRouteLocations.settings('models'))
  },
  { immediate: true },
)

function continueSetup() {
  providerSettings.clearModelProviderError()
  showAddDialog.value = true
}

async function removeProvider() {
  await providerSettings.removeProvider(props.providerId)
}

async function leaveProvider() {
  await router.replace(desktopRouteLocations.settings('models'))
}
const { authChallenge, language } = providerSettings
</script>

<template>
  <DesktopSettingsPageLayout requires-runtime>
    <template #title>
      <span class="desktop-provider-settings-view__breadcrumb desktop-settings-page__breadcrumb">
        <button type="button" @click="leaveProvider">
          {{ t('desktop.settings.category.models') }}
        </button>
        <span>/</span>
        <span>{{ provider?.displayName ?? providerId }}</span>
      </span>
    </template>
    <template #description>
      {{ providerSummary }}
    </template>
    <template v-if="provider" #actions>
      <NTooltip :delay="350">
        <template #trigger>
          <span class="desktop-provider-settings-view__action">
            <NPopconfirm
              :negative-text="t('common.cancel')"
              :positive-text="t('common.confirm')"
              @positive-click="removeProvider"
            >
              <template #trigger>
                <NButton
                  class="buddy-icon-button desktop-provider-settings-view__remove"
                  quaternary
                  size="small"
                  :disabled="removeDisabled"
                  :aria-label="t('desktop.providers.removeService')"
                >
                  <template #icon>
                    <DesktopIcon name="delete" :size="16" />
                  </template>
                </NButton>
              </template>
              {{ t('desktop.providers.removeServiceConfirmation') }}
            </NPopconfirm>
          </span>
        </template>
        {{ t('desktop.providers.removeService') }}
      </NTooltip>
      <span class="desktop-provider-settings-view__divider" aria-hidden="true" />
      <NSwitch
        :round="false"
        :value="provider.enabled"
        :disabled="provider.activeRunCount > 0 || (!provider.enabled && !provider.setupComplete)"
        @update:value="providerSettings.setProviderEnabled(provider.id, $event)"
      />
    </template>

    <DesktopProviderDetail
      v-if="provider"
      :provider-id="providerId"
      :provider-settings="providerSettings"
      @continue-setup="continueSetup"
    />
    <DesktopProviderAddDialog
      v-model:show="showAddDialog"
      :provider-settings="providerSettings"
      :resume-provider-id="providerId"
    />
    <DesktopProviderAuthDialog
      :challenge="authChallenge"
      :provider-name="authProviderName"
      :language="language"
      @cancel="providerSettings.cancelAuth"
      @submit="providerSettings.respondToAuth"
    />
  </DesktopSettingsPageLayout>
</template>

<style scoped>
.desktop-provider-settings-view__action {
  display: inline-flex;
}

.desktop-provider-settings-view__remove:not(:disabled):hover {
  color: var(--buddy-status-danger-text);
}

.desktop-provider-settings-view__divider {
  width: 1px;
  height: 14px;
  background: var(--buddy-border-subtle);
}

.desktop-provider-settings-view__breadcrumb {
  display: flex;
  min-width: 0;
  align-items: center;
}

.desktop-provider-settings-view__breadcrumb button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-weight: inherit;
  padding: 0;
}

.desktop-provider-settings-view__breadcrumb button:hover {
  color: var(--buddy-accent-text);
}

.desktop-provider-settings-view__breadcrumb button:focus-visible {
  border-radius: var(--buddy-radius-micro);
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 2px;
}

.desktop-provider-settings-view__breadcrumb span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
