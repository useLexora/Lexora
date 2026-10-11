<script setup lang="ts">
import type { LocalProvider } from '@buddy-shared/providers/providerApi'

import type { ModelProvidersStore } from '@/modules/models/state/typing'
import { Add20Regular, Info20Regular } from '@vicons/fluent'
import { NButton, NEmpty, NPopconfirm, NSwitch, NTooltip } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopModelSnapshotStatus from '@/modules/models/widgets/providers/DesktopModelSnapshotStatus.vue'
import DesktopProviderAddDialog from '@/modules/models/widgets/providers/DesktopProviderAddDialog.vue'
import DesktopProviderAuthDialog from '@/modules/models/widgets/providers/DesktopProviderAuthDialog.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ providerSettings: ModelProvidersStore }>()
const emit = defineEmits<{
  manageProvider: [providerId: string]
}>()
const language = computed(() => props.providerSettings.language.value)
const { t } = useBuddyI18n(language)
const showAddDialog = shallowRef(false)
const resumeProviderId = shallowRef<string | null>(null)

const addedProviders = computed(() => props.providerSettings.providers.value.filter(provider => provider.added))
const authProviderName = computed(() => props.providerSettings.providers.value.find(
  provider => provider.id === props.providerSettings.authChallenge.value?.providerId,
)?.displayName ?? null)

function openAddDialog(providerId: string | null = null) {
  props.providerSettings.clearModelProviderError()
  resumeProviderId.value = providerId
  showAddDialog.value = true
}

function manageProvider(providerId: string) {
  emit('manageProvider', providerId)
}

function providerAuthenticationLabel(type: NonNullable<LocalProvider['storedCredentialType']>) {
  return type === 'api_key' ? 'API Key' : 'OAuth'
}
</script>

<template>
  <div class="desktop-models-settings gap-[1.8rem]">
    <section class="desktop-models-settings__section">
      <div class="desktop-models-settings__heading flex items-start justify-between gap-4">
        <div>
          <h2>{{ t('desktop.providers.addedServices') }}</h2>
          <p>{{ t('desktop.providers.addedServicesDescription') }}</p>
        </div>
        <NButton size="small" type="primary" @click="openAddDialog()">
          <template #icon>
            <DesktopIcon :component="Add20Regular" />
          </template>
          {{ t('desktop.providers.addService') }}
        </NButton>
      </div>

      <div v-if="addedProviders.length" class="desktop-models-settings__group">
        <article
          v-for="provider in addedProviders"
          :key="provider.id"
          class="desktop-models-settings__provider-row flex min-h-[4.2rem] items-center gap-3 border-b-1 border-b-solid border-b-border py-[0.7rem] px-[0.9rem] last:border-b-0"
        >
          <div class="grid min-w-0 flex-1 gap-1">
            <div class="flex min-w-0 items-baseline gap-[0.45rem]">
              <strong class="overflow-hidden min-w-0 text-[0.78rem] text-ellipsis whitespace-nowrap">
                {{ provider.displayName }}
              </strong>
              <span
                v-if="provider.storedCredentialType"
                class="flex-none text-accent-text text-[0.66rem] font-600"
              >
                {{ providerAuthenticationLabel(provider.storedCredentialType) }}
              </span>
            </div>
            <div class="flex overflow-hidden min-w-0 items-center text-muted text-[0.68rem]">
              <span class="desktop-models-settings__provider-models">
                {{ provider.modelCount
                  ? t('desktop.providers.enabledModelSummary', {
                    enabled: provider.enabledModelCount,
                    total: provider.modelCount,
                  })
                  : t('desktop.providers.noModels') }}
              </span>
              <template v-if="provider.description">
                <span class="desktop-models-settings__provider-separator my-0 mx-[0.35rem] text-muted">|</span>
                <span class="overflow-hidden min-w-0 text-ellipsis whitespace-nowrap">
                  {{ provider.description }}
                </span>
              </template>
            </div>
          </div>
          <template v-if="!provider.setupComplete">
            <NButton size="small" @click="openAddDialog(provider.id)">
              {{ t('desktop.providers.continueSetup') }}
            </NButton>
            <NPopconfirm
              :negative-text="t('common.cancel')"
              :positive-text="t('common.confirm')"
              @positive-click="providerSettings.removeProvider(provider.id)"
            >
              <template #trigger>
                <NButton type="error" size="small" :disabled="provider.activeRunCount > 0">
                  {{ t('common.delete') }}
                </NButton>
              </template>
              {{ t('desktop.providers.removeServiceConfirmation') }}
            </NPopconfirm>
          </template>
          <template v-else>
            <NTooltip v-if="provider.enabledModelCount === 0">
              <template #trigger>
                <span
                  class="desktop-models-settings__provider-availability grid w-6 h-6 flex-none place-items-center text-warning"
                  role="img"
                  :aria-label="t('desktop.providers.noEnabledAvailableModelsHint')"
                >
                  <DesktopIcon :component="Info20Regular" :size="18" />
                </span>
              </template>
              {{ t('desktop.providers.noEnabledAvailableModelsHint') }}
            </NTooltip>
            <NButton size="small" @click="manageProvider(provider.id)">
              {{ t('desktop.providers.manage') }}
            </NButton>
            <NSwitch
              :round="false"
              :value="provider.enabled"
              :disabled="provider.activeRunCount > 0 || (!provider.enabled && provider.enabledModelCount === 0)"
              @update:value="providerSettings.setProviderEnabled(provider.id, $event)"
            />
          </template>
        </article>
      </div>
      <div v-else class="desktop-models-settings__empty p-[0.9rem] py-[2.6rem] px-4">
        <NEmpty :description="t('desktop.providers.noAddedServices')">
          <template #extra>
            <NButton type="primary" @click="openAddDialog()">
              {{ t('desktop.providers.addService') }}
            </NButton>
          </template>
        </NEmpty>
      </div>
    </section>

    <section class="desktop-models-settings__section desktop-models-settings__snapshot-section">
      <h2 class="desktop-models-settings__section-title">
        {{ t('desktop.providers.modelSnapshot') }}
      </h2>
      <DesktopModelSnapshotStatus
        :language="language"
        :refreshing="providerSettings.isRefreshingModelSnapshot.value"
        :snapshot="providerSettings.modelSnapshot.value"
        @open-directory="providerSettings.openModelSnapshotDirectory"
        @refresh="providerSettings.refreshModelSnapshot"
      />
    </section>

    <DesktopProviderAddDialog
      v-model:show="showAddDialog"
      :provider-settings="providerSettings"
      :resume-provider-id="resumeProviderId"
    />
    <DesktopProviderAuthDialog
      :challenge="providerSettings.authChallenge.value"
      :provider-name="authProviderName"
      :language="language"
      @cancel="providerSettings.cancelAuth"
      @submit="providerSettings.respondToAuth"
    />
  </div>
</template>

<style scoped lang="scss">
.desktop-models-settings,
.desktop-models-settings__section {
  display: grid;
  gap: 0.8rem;
}

.desktop-models-settings__heading h2,
.desktop-models-settings__heading p,
.desktop-models-settings__section-title {
  margin: 0;
}

.desktop-models-settings__heading h2,
.desktop-models-settings__section-title {
  font-size: 0.92rem;
}

.desktop-models-settings__heading p {
  max-width: 42rem;
  margin-top: 0.25rem;
  color: var(--buddy-text-secondary);
  font-size: 0.72rem;
  line-height: 1.5;
}

.desktop-models-settings__group,
.desktop-models-settings__empty {
  overflow: hidden;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 0.65rem;
  background: var(--buddy-surface-base);
}

.desktop-models-settings__provider-models,
.desktop-models-settings__provider-separator {
  flex: none;
}
</style>
