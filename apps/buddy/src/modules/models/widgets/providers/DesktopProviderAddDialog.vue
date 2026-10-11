<script setup lang="ts">
import type { ModelProvidersStore } from '@/modules/models/state/typing'
import { providerRequestHeadersSchema } from '@buddy-shared/providers/providerHeaders'

import { Add20Regular } from '@vicons/fluent'
import { NButton, NCard, NCollapse, NCollapseItem, NEmpty, NForm, NInput, NModal, NSpace, NStep, NSteps, NSwitch, NTabPane, NTabs, NTooltip } from 'naive-ui'
import { computed, nextTick, shallowRef, toRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useProviderSetupWizard } from '@/modules/models/state/useProviderSetupWizard'
import DesktopManualModelDialog from '@/modules/models/widgets/providers/DesktopManualModelDialog.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopCustomProviderForm from './DesktopCustomProviderForm.vue'
import DesktopProviderHeadersEditor from './DesktopProviderHeadersEditor.vue'

const props = defineProps<{
  providerSettings: ModelProvidersStore
  resumeProviderId: string | null
}>()
const show = defineModel<boolean>('show', { required: true })
const language = computed(() => props.providerSettings.language.value)
const { t } = useBuddyI18n(language)
const {
  addingBuiltin,
  addBuiltin,
  builtinDisplayName,
  builtinHeaders,
  canComplete,
  canLogin,
  closeDialog,
  continueFromModels,
  createCustom,
  customForm,
  creatingCustom,
  customIdConflict,
  reservedCustomIds,
  updateCustomForm,
  filteredProviders,
  furthestStep,
  goToPreviousStep,
  login,
  manualFormKey,
  navigateToReachedStep,
  openManualModelDialog,
  providerModels,
  providerQuery,
  saveManualModel,
  savingManualModel,
  selectedProvider,
  showManualModelDialog,
  sourceTab,
  step,
  stepCount,
  toggleModel,
} = useProviderSetupWizard({
  providerSettings: () => props.providerSettings,
  resumeProviderId: toRef(props, 'resumeProviderId'),
  show,
})
const connectionForm = useTemplateRef('connectionForm')
const expandedConnection = shallowRef<string[]>([])
watch([show, step], () => {
  expandedConnection.value = []
})
async function connect(authType: 'api_key' | 'oauth') {
  try {
    if (!selectedProvider.value?.custom && !providerRequestHeadersSchema.safeParse(builtinHeaders.requestHeaders).success) {
      expandedConnection.value = ['advanced']
      await nextTick()
    }
    await connectionForm.value?.validate()
  }
  catch {
    return
  }
  await login(authType)
}
</script>

<template>
  <NModal
    v-model:show="show"
    :mask-closable="false"
  >
    <NCard
      class="desktop-provider-add-dialog"
      closable
      content-style="display: flex; flex-direction: column; min-height: 0; overflow: hidden;"
      :style="{ width: 'min(64rem, calc(100vw - 2rem))' }"
      @close="closeDialog"
    >
      <template #header>
        <div class="desktop-provider-add-dialog__title">
          <strong>{{ t('desktop.providers.addService') }}</strong>
          <span v-if="furthestStep > 1">{{ t('desktop.providers.stepProgress', { current: step, total: stepCount }) }}</span>
        </div>
      </template>

      <NSteps
        v-if="furthestStep > 1"
        :current="step"
        size="small"
        @update:current="navigateToReachedStep"
      >
        <NStep :title="t('desktop.providers.serviceStep')" />
        <NStep :disabled="furthestStep < 2" :title="t('desktop.providers.connectionStep')" />
        <NStep :disabled="furthestStep < 3" :title="t('desktop.providers.modelsStep')" />
      </NSteps>

      <div
        :key="step"
        class="desktop-provider-add-dialog__scroll min-h-0 overflow-auto"
        :class="{ 'is-model-step': step === 3 }"
      >
        <div v-if="step === 1" class="desktop-provider-add-dialog__body">
          <NTabs v-model:value="sourceTab" type="line" animated>
            <NTabPane name="builtin" :tab="t('desktop.providers.builtinTab')">
              <div class="desktop-provider-add-dialog__catalog box-border p-[2px]">
                <NInput v-model:value="providerQuery" :placeholder="t('desktop.providers.searchPlaceholder')" clearable />
                <div v-if="filteredProviders.length" class="desktop-provider-add-dialog__provider-list-frame overflow-hidden">
                  <div class="max-h-96 overflow-auto">
                    <div v-for="provider in filteredProviders" :key="provider.id" class="desktop-provider-add-dialog__provider-row">
                      <div>
                        <strong>{{ provider.displayName }}</strong>
                        <small>{{ provider.authTypes.map(type => type === 'api_key' ? 'API Key' : 'OAuth').join(' / ') }}</small>
                      </div>
                      <NButton size="small" type="primary" :disabled="addingBuiltin" @click="addBuiltin(provider)">
                        {{ provider.id === selectedProvider?.builtinProviderId && furthestStep > 1
                          ? t('desktop.providers.continue')
                          : t('desktop.providers.add') }}
                      </NButton>
                    </div>
                  </div>
                </div>
                <NEmpty v-else :description="t('desktop.providers.noSearchResults')" />
              </div>
            </NTabPane>
            <NTabPane name="custom" :tab="t('desktop.providers.customTab')">
              <DesktopCustomProviderForm
                :value="customForm"
                :language="language"
                :reserved-ids="reservedCustomIds"
                :conflict-id="customIdConflict"
                :identifier-locked="selectedProvider?.custom === true"
                :saving="creatingCustom"
                @update:value="updateCustomForm"
                @submit="createCustom"
              />
            </NTabPane>
          </NTabs>
        </div>

        <div v-else-if="step === 2" class="desktop-provider-add-dialog__step">
          <h3>{{ t('desktop.providers.configureConnection') }}</h3>
          <label v-if="selectedProvider && !selectedProvider.custom" class="desktop-provider-add-dialog__service-name grid gap-[0.35rem] max-w-112">
            <span>{{ t('desktop.providers.displayName') }}</span>
            <NInput v-model:value="builtinDisplayName" :maxlength="100" :placeholder="t('desktop.providers.displayNamePlaceholder')" />
          </label>
          <p v-else>
            {{ selectedProvider?.displayName }}
          </p>
          <NSpace>
            <NButton
              v-for="authType in selectedProvider?.authTypes ?? []"
              :key="authType"
              type="primary"
              :disabled="!canLogin || providerSettings.isAuthenticating.value"
              :loading="providerSettings.isAuthenticating.value && !providerSettings.authChallenge.value"
              @click="connect(authType)"
            >
              {{ authType === 'api_key' ? t('desktop.providers.configureApiKey') : t('desktop.providers.useOAuth') }}
            </NButton>
          </NSpace>
          <NForm v-if="selectedProvider && !selectedProvider.custom" ref="connectionForm" :model="builtinHeaders" :disabled="providerSettings.isAuthenticating.value">
            <NCollapse v-model:expanded-names="expandedConnection" arrow-placement="right">
              <NCollapseItem :title="t('desktop.providers.advancedSettings')" name="advanced" display-directive="show">
                <DesktopProviderHeadersEditor v-model:value="builtinHeaders.requestHeaders" :language="language" :disabled="providerSettings.isAuthenticating.value" />
              </NCollapseItem>
            </NCollapse>
          </NForm>
        </div>

        <div v-else-if="step === 3" class="desktop-provider-add-dialog__step is-model-step">
          <div class="desktop-provider-add-dialog__step-heading">
            <div>
              <h3>{{ t('desktop.providers.configureModels') }}</h3>
              <p>
                {{ t(selectedProvider?.custom
                  ? 'desktop.providers.configureModelsDescription'
                  : 'desktop.providers.configureBuiltinModelsDescription') }}
              </p>
            </div>
            <div v-if="selectedProvider?.custom" class="desktop-provider-add-dialog__model-actions">
              <NTooltip :disabled="selectedProvider.canSyncModels">
                <template #trigger>
                  <span>
                    <NButton
                      size="small"
                      :disabled="!selectedProvider.canSyncModels"
                      :loading="providerSettings.syncingProviderId.value === selectedProvider.id"
                      @click="providerSettings.syncProviderModels(selectedProvider.id)"
                    >
                      {{ t('desktop.providers.syncModels') }}
                    </NButton>
                  </span>
                </template>
                {{ t(`desktop.providers.syncUnavailable.${selectedProvider.syncUnavailableReason ?? 'unsupported_api'}`) }}
              </NTooltip>
              <NButton
                class="buddy-icon-button desktop-provider-add-dialog__add-model"
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

          <div class="desktop-provider-add-dialog__models min-h-0 overflow-auto">
            <div class="sticky z-1 top-0 flex min-h-10 items-center justify-between border-b-1 border-b-solid border-b-border bg-surface text-muted text-[0.7rem] font-600 py-[0.55rem] px-[0.8rem]">
              <span>{{ t('desktop.providers.modelColumn') }}</span>
              <span>{{ t('desktop.providers.enabledColumn') }}</span>
            </div>
            <div v-for="model in providerModels" :key="model.modelId" class="desktop-provider-add-dialog__model-row">
              <div>
                <strong>{{ model.displayName }}</strong>
                <small>{{ model.modelId }}</small>
              </div>
              <span v-if="!model.available">{{ t('desktop.providers.notFoundInLastSync') }}</span>
              <NSwitch
                :round="false"
                :value="model.enabled"
                :disabled="!model.available"
                @update:value="toggleModel(model.modelId, $event)"
              />
            </div>
          </div>
        </div>
      </div>

      <div v-if="step > 1" class="desktop-provider-add-dialog__footer flex items-center justify-between border-t-1 border-t-solid border-t-border mt-[0.8rem] pt-[0.8rem]">
        <NButton @click="goToPreviousStep">
          {{ t('desktop.providers.previous') }}
        </NButton>
        <NButton
          v-if="step === 3"
          type="primary"
          :disabled="!canComplete"
          @click="continueFromModels"
        >
          {{ t('desktop.providers.finishAndEnable') }}
        </NButton>
      </div>
    </NCard>
  </NModal>
  <DesktopManualModelDialog
    v-model:show="showManualModelDialog"
    :form-key="manualFormKey"
    :language="language"
    :saving="savingManualModel"
    @save="saveManualModel"
  />
</template>

<style scoped lang="scss">
.desktop-provider-add-dialog__service-name > span {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
}

.desktop-provider-add-dialog {
  width: min(64rem, calc(100vw - 2rem));
  max-height: min(46rem, calc(100dvh - 3rem));
  overflow: hidden;
}

.desktop-provider-add-dialog :deep(.n-card-content),
.desktop-provider-add-dialog :deep(.n-tabs),
.desktop-provider-add-dialog :deep(.n-tab-pane),
.desktop-provider-add-dialog :deep(.n-steps) {
  width: 100%;
  min-width: 0;
}

.desktop-provider-add-dialog :deep(.n-card-header) {
  flex: 0 0 auto;
}

.desktop-provider-add-dialog :deep(.n-step:last-child) {
  flex: 0 0 auto;
}

.desktop-provider-add-dialog :deep(.n-steps) {
  flex: 0 0 auto;
  margin-top: 1px;
}

.desktop-provider-add-dialog__scroll {
  flex: 1 1 auto;
  overscroll-behavior: contain;
}

.desktop-provider-add-dialog__scroll.is-model-step {
  display: flex;
  overflow: hidden;
}

.desktop-provider-add-dialog__footer {
  flex: 0 0 auto;
}

.desktop-provider-add-dialog__title,
.desktop-provider-add-dialog__step-heading,
.desktop-provider-add-dialog__model-actions,
.desktop-provider-add-dialog__provider-row,
.desktop-provider-add-dialog__model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.desktop-provider-add-dialog__title span,
.desktop-provider-add-dialog__provider-row small,
.desktop-provider-add-dialog__model-row small,
.desktop-provider-add-dialog__step p {
  color: var(--buddy-text-secondary);
  font-size: 0.72rem;
}

.desktop-provider-add-dialog__body,
.desktop-provider-add-dialog__step,
.desktop-provider-add-dialog__catalog {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
}

.desktop-provider-add-dialog__step.is-model-step {
  width: 100%;
  min-height: 0;
  flex: 1;
  grid-template-rows: auto minmax(0, 1fr);
}

.desktop-provider-add-dialog__provider-list-frame,
.desktop-provider-add-dialog__models {
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 0.65rem;
}

.desktop-provider-add-dialog__provider-row,
.desktop-provider-add-dialog__model-row {
  min-height: 3.8rem;
  border-bottom: 1px solid var(--buddy-border-subtle);
  padding: 0.65rem 0.8rem;
}

.desktop-provider-add-dialog__provider-row:last-child,
.desktop-provider-add-dialog__model-row:last-child {
  border-bottom: 0;
}

.desktop-provider-add-dialog__provider-row > div,
.desktop-provider-add-dialog__model-row > div {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}

.desktop-provider-add-dialog__step h3,
.desktop-provider-add-dialog__step p,
.desktop-provider-add-dialog__step-heading h3,
.desktop-provider-add-dialog__step-heading p {
  margin: 0;
}

.desktop-provider-add-dialog__actions {
  display: flex;
  justify-content: flex-end;
}
</style>
