<script setup lang="ts">
import type { ModelProvidersStore } from '@/modules/models/state/typing'
import { Add20Regular, Info20Regular, Search20Regular } from '@vicons/fluent'
import { NButton, NInput, NPopconfirm, NSpace, NSwitch, NTooltip } from 'naive-ui'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopManualModelDialog from '@/modules/models/widgets/providers/DesktopManualModelDialog.vue'
import DesktopModelCapabilityTags from '@/modules/models/widgets/providers/DesktopModelCapabilityTags.vue'
import DesktopModelDetailDialog from '@/modules/models/widgets/providers/DesktopModelDetailDialog.vue'
import DesktopProviderConnectionDialog from '@/modules/models/widgets/providers/DesktopProviderConnectionDialog.vue'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import { useProviderDetail } from './useProviderDetail'

const props = defineProps<{
  providerSettings: ModelProvidersStore
  providerId: string
}>()
const emit = defineEmits<{
  continueSetup: [providerId: string]
}>()
const router = useRouter()
const language = computed(() => props.providerSettings.language.value)
const { t } = useBuddyI18n(language)
const {
  provider,
  models,
  selectedModel,
  modelActions,
  connectionActions,
  connectionSummary,
  savingManualModel,
  manualFormKey,
  showManualModelDialog,
  showModelDetailDialog,
  showConnectionDialog,
  saveManualModel,
  openManualModelDialog,
  openModelDetail,
  formatTokens,
  removeUnavailableModel,
} = useProviderDetail(() => props.providerSettings, () => props.providerId)
const typeFilter = ref('all')
const query = ref('')
const typeOptions = computed(() => (['all', 'chat', 'transcription', 'speech'] as const).map(value => ({ value, label: t(`desktop.providers.modelTypes.${value}`) })))
const visibleModels = computed(() => {
  const search = query.value.trim().toLocaleLowerCase()
  return models.value.filter(model => (typeFilter.value === 'all' || model.type === typeFilter.value)
    && (!search || [model.displayName, model.modelId].some(value => value.toLocaleLowerCase().includes(search))))
})
function managePlugin() {
  const plugin = provider.value?.plugin
  return router.push(plugin?.managementPage ? desktopRouteLocations.extensionPage(plugin.id) : desktopRouteLocations.extensions())
}
</script>

<template>
  <div v-if="provider" class="desktop-provider-detail grid gap-[1.8rem]">
    <section v-if="provider.plugin" class="desktop-provider-detail__section">
      <h3>{{ t('desktop.providers.pluginManaged') }}</h3>
      <p>{{ t(provider.status === 'available' ? 'desktop.providers.pluginManagedDescription' : 'desktop.providers.pluginUnavailable') }}</p>
      <NButton size="small" @click="managePlugin">
        {{ t('desktop.providers.managePlugin') }}
      </NButton>
    </section>
    <section v-else-if="!provider.setupComplete" class="desktop-provider-detail__notice flex items-center gap-[0.8rem] justify-between border-1 border-solid border-border-strong rounded-[0.65rem] bg-subtle py-[0.8rem] px-[0.9rem]">
      <div class="grid min-w-0 flex-1 gap-[0.2rem]">
        <strong>{{ t('desktop.providers.setupIncomplete') }}</strong>
        <span>{{ t('desktop.providers.setupIncompleteDescription') }}</span>
      </div>
      <NButton type="primary" size="small" @click="emit('continueSetup', provider.id)">
        {{ t('desktop.providers.continueSetup') }}
      </NButton>
    </section>

    <section v-if="!provider.plugin" class="desktop-provider-detail__section">
      <h3>{{ t('desktop.providers.connectionStep') }}</h3>
      <div class="overflow-hidden border border-solid border-border rounded-[0.65rem]">
        <div class="desktop-provider-detail__row min-h-16 border-b-1 border-b-solid border-b-border py-[0.7rem] px-[0.9rem] last:border-b-0">
          <div class="desktop-provider-detail__row-copy grid min-w-0 flex-1 gap-[0.2rem]">
            <strong>{{ t('desktop.providers.authenticationStatus') }}</strong>
            <small>{{ provider.storedCredentialType
              ? (provider.storedCredentialType === 'api_key' ? 'API Key' : 'OAuth')
              : t('desktop.providers.authenticationNotConfigured') }}</small>
          </div>
          <NSpace v-if="!provider.storedCredentialType">
            <NButton
              v-for="authType in provider.authTypes"
              :key="authType"
              size="small"
              :disabled="providerSettings.isAuthenticating.value"
              :loading="providerSettings.isAuthenticating.value && !providerSettings.authChallenge.value"
              @click="providerSettings.loginProvider(provider.id, authType)"
            >
              {{ authType === 'api_key' ? t('desktop.providers.configureApiKey') : t('desktop.providers.useOAuth') }}
            </NButton>
          </NSpace>
          <NPopconfirm
            v-else
            :negative-text="t('common.cancel')"
            :positive-text="t('common.confirm')"
            @positive-click="providerSettings.clearProviderCredential(provider.id)"
          >
            <template #trigger>
              <NButton size="small" :disabled="provider.activeRunCount > 0">
                {{ t('desktop.providers.clearAuthentication') }}
              </NButton>
            </template>
            {{ t('desktop.providers.clearAuthenticationConfirmation') }}
          </NPopconfirm>
        </div>
        <div class="desktop-provider-detail__row min-h-16 border-b-1 border-b-solid border-b-border py-[0.7rem] px-[0.9rem] last:border-b-0">
          <div class="desktop-provider-detail__row-copy grid min-w-0 flex-1 gap-[0.2rem]">
            <strong>{{ t('desktop.providers.connectionSettings') }}</strong>
            <small>{{ connectionSummary }}</small>
          </div>
          <NButton size="small" @click="showConnectionDialog = true">
            {{ t('common.edit') }}
          </NButton>
        </div>
      </div>
    </section>

    <section v-if="!provider.plugin || models.length" class="desktop-provider-detail__section">
      <div class="desktop-provider-detail__section-heading flex items-start gap-[0.8rem] justify-between">
        <div class="grid min-w-0 flex-1 gap-[0.2rem]">
          <h3>{{ t('desktop.providers.models') }}</h3>
          <p>{{ t('desktop.providers.modelsDescription') }}</p>
        </div>
        <div v-if="!provider.plugin" class="flex flex-none items-center gap-2">
          <NTooltip :disabled="provider.canSyncModels">
            <template #trigger>
              <span>
                <NButton
                  size="small"
                  :disabled="!provider.canSyncModels"
                  :loading="providerSettings.syncingProviderId.value === provider.id"
                  @click="providerSettings.syncProviderModels(provider.id)"
                >
                  {{ t('desktop.providers.fetchServiceModels') }}
                </NButton>
              </span>
            </template>
            {{ t(`desktop.providers.syncUnavailable.${provider.syncUnavailableReason ?? 'unsupported_api'}`) }}
          </NTooltip>
          <NButton
            v-if="!provider.plugin"
            class="buddy-icon-button desktop-provider-detail__add-model"
            quaternary
            size="small"
            :aria-label="t('desktop.providers.addModelManually')"
            @click="openManualModelDialog"
          >
            <template #icon>
              <DesktopIcon :component="Add20Regular" />
            </template>
          </NButton>
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <DesktopSegmentedControl v-model="typeFilter" :options="typeOptions" :aria-label="t('desktop.providers.modelType')" />
        <NInput v-model:value="query" class="basis-64 max-w-full ml-auto" clearable :placeholder="t('desktop.chat.searchModels')" :aria-label="t('desktop.chat.searchModels')">
          <template #prefix>
            <DesktopIcon :component="Search20Regular" />
          </template>
        </NInput>
      </div>
      <div v-if="visibleModels.length" class="overflow-hidden border border-solid border-border rounded-[0.65rem]">
        <div
          v-for="model in visibleModels"
          :key="model.modelId"
          class="desktop-provider-detail__row desktop-provider-detail__model-row min-h-16 border-b-1 border-b-solid border-b-border py-[0.7rem] px-[0.9rem] last:border-b-0"
        >
          <div class="desktop-provider-detail__row-copy grid min-w-0 flex-1 gap-[0.2rem]">
            <strong>{{ model.displayName }}</strong>
            <small>{{ model.modelId }}</small>
            <small v-if="model.type === 'chat'" class="desktop-provider-detail__model-parameters">
              {{ t('desktop.providers.compactParameters', {
                contextWindow: formatTokens(model.contextWindow),
                maxTokens: formatTokens(model.maxTokens),
              }) }}
            </small>
            <small>{{ t(`desktop.providers.modelTypes.${model.type}`) }}</small>
            <DesktopModelCapabilityTags v-if="model.type === 'chat'" :language="language" :model="model" />
          </div>
          <div class="flex flex-none items-center ml-auto gap-[0.4rem]">
            <template v-if="model.available">
              <NButton size="small" @click="provider.plugin ? managePlugin() : openModelDetail(model.modelId)">
                {{ t('desktop.providers.manage') }}
              </NButton>
              <NSwitch
                :round="false"
                :value="model.enabled"
                :disabled="provider.activeRunCount > 0"
                @update:value="providerSettings.setProviderModelEnabled(provider.id, model.modelId, $event)"
              />
            </template>
            <template v-else>
              <NTooltip>
                <template #trigger>
                  <span
                    class="desktop-provider-detail__model-availability grid w-6 h-6 flex-none place-items-center text-warning"
                    role="img"
                    :aria-label="t('desktop.providers.notFoundInLastSync')"
                  >
                    <DesktopIcon :component="Info20Regular" :size="18" />
                  </span>
                </template>
                {{ t('desktop.providers.modelUnavailableHint') }}
              </NTooltip>
              <NTooltip>
                <template #trigger>
                  <span>
                    <NButton
                      class="buddy-icon-button"
                      quaternary
                      size="small"
                      :disabled="provider.activeRunCount > 0 || providerSettings.mutatingProviderId.value === provider.id"
                      :aria-label="t('desktop.providers.removeUnavailableModel')"
                      @click="removeUnavailableModel(model.modelId)"
                    >
                      <template #icon>
                        <DesktopIcon name="delete" :size="16" />
                      </template>
                    </NButton>
                  </span>
                </template>
                {{ t('desktop.providers.removeUnavailableModel') }}
              </NTooltip>
            </template>
          </div>
        </div>
      </div>
      <p v-else class="m-0 py-8 text-center text-muted text-sm" role="status">
        {{ t(models.length ? 'desktop.chat.noMatchingModels' : 'desktop.providers.noModels') }}
      </p>
    </section>
  </div>
  <DesktopManualModelDialog
    v-model:show="showManualModelDialog"
    :form-key="manualFormKey"
    :allow-chat="!!provider?.custom"
    :language="language"
    :saving="savingManualModel"
    @save="saveManualModel"
  />
  <DesktopModelDetailDialog
    v-model:show="showModelDetailDialog"
    :actions="modelActions"
    :language="language"
    :model="selectedModel"
    :disabled="(provider?.activeRunCount ?? 0) > 0"
    :saving="providerSettings.mutatingProviderId.value === providerId"
  />
  <DesktopProviderConnectionDialog
    v-if="provider"
    v-model:show="showConnectionDialog"
    :actions="connectionActions"
    :language="language"
    :provider="provider"
  />
</template>

<style scoped lang="scss">
.desktop-provider-detail__section {
  display: grid;
  gap: 0.8rem;
}

.desktop-provider-detail__row {
  display: flex;
  align-items: center;
  gap: 0.8rem;
}

.desktop-provider-detail__model-parameters {
  font-variant-numeric: tabular-nums;
}

.desktop-provider-detail__section h3,
.desktop-provider-detail__section-heading p {
  margin: 0;
}

.desktop-provider-detail__section h3 {
  font-size: 0.92rem;
}

.desktop-provider-detail__row small,
.desktop-provider-detail__notice span,
.desktop-provider-detail__section-heading p {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
}
</style>
