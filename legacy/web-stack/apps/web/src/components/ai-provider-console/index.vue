<script setup lang="ts">
import type { AiProviderConsoleMode, AiProviderFormController } from './typing'
import { useTemplateRef } from 'vue'
import CompatibleProviderDialog from './components/compatible-provider-dialog'
import ConsoleContent from './components/console-content'
import CreateModelDialog from './components/create-model-dialog'
import DiscoverModelsDialog from './components/discover-models-dialog'
import ModelCapabilityDialog from './components/model-capability-dialog'
import ProviderSidebar from './components/provider-sidebar'
import { useAiProviderConsole } from './composables/useAiProviderConsole'

const props = defineProps<{
  mode: AiProviderConsoleMode
}>()

const createCompatibleProviderFormRef = useTemplateRef<AiProviderFormController>('createCompatibleProviderFormRef')
const editCompatibleProviderFormRef = useTemplateRef<AiProviderFormController>('editCompatibleProviderFormRef')
const createModelFormRef = useTemplateRef<AiProviderFormController>('createModelFormRef')

const {
  compatiblePresets,
  filteredRows,
  selectedRowKey,
  searchKeyword,
  isLoading,
  isLoadingModels,
  isDiscoveringModels,
  isAddingDiscoveredModels,
  isCreatingModel,
  isSavingModelCapability,
  isUpdatingProviderStatus,
  isSavingEndpoint,
  isSavingApiKey,
  isLoadingApiKey,
  isCreatingCompatibleProvider,
  isUpdatingCompatibleProvider,
  createCompatibleProviderDialogVisible,
  editCompatibleProviderDialogVisible,
  discoverDialogVisible,
  createModelDialogVisible,
  modelCapabilityDialogVisible,
  endpointForm,
  apiKeyForm,
  compatibleProviderCreateForm,
  compatibleProviderEditForm,
  createModelForm,
  modelCapabilityForm,
  models,
  filteredDiscoveredModels,
  discoverSearchKeyword,
  selectedRow,
  selectedProvider,
  canEditEndpoint,
  requiresApiKey,
  selectedTitle,
  discoverModelsButtonText,
  modelSummaryText,
  shouldShowModelsEmptyState,
  compatibleProviderCreateRules,
  compatibleProviderEditRules,
  createModelRules,
  modelCapabilityRules,
  selectRow,
  openCreateCompatibleProviderDialog,
  createCompatibleProvider,
  updateCompatibleProvider,
  handleCompatibleProviderCommand,
  saveApiKey,
  saveEndpoint,
  updateProviderEnabled,
  openDiscoverModelsDialog,
  refreshDiscoveredModels,
  addAllDiscoveredModels,
  openCreateModelDialog,
  handleCreateModelIdInput,
  createModel,
  openModelCapabilityDialog,
  saveModelCapability,
  updateModelStatus,
  isModelUpdating,
  getProviderInitial,
  getProviderStatusType,
  handleRowContextMenu,
} = useAiProviderConsole({
  mode: () => props.mode,
  createCompatibleProviderFormRef,
  editCompatibleProviderFormRef,
  createModelFormRef,
})
</script>

<template>
  <div class="ai-provider-console">
    <ElSkeleton v-if="isLoading" animated class="ai-provider-console__skeleton">
      <template #template>
        <aside class="ai-provider-console__skeleton-sidebar">
          <ElSkeletonItem variant="rect" class="h-9 w-full rounded-md" />
          <div class="grid gap-2">
            <div v-for="item in 6" :key="item" class="flex items-center gap-3 rounded-lg border border-border-a60 p-3">
              <ElSkeletonItem variant="circle" class="h-9 w-9 shrink-0" />
              <div class="grid min-w-0 flex-1 gap-2">
                <ElSkeletonItem variant="h3" class="max-w-36" />
                <ElSkeletonItem variant="text" class="max-w-48" />
              </div>
            </div>
          </div>
        </aside>

        <main class="ai-provider-console__skeleton-main">
          <section class="rounded-lg border border-border-a60 p-5">
            <div class="mb-4 flex items-center justify-between gap-4">
              <ElSkeletonItem variant="h3" class="max-w-48" />
              <ElSkeletonItem variant="button" class="h-8 max-w-24" />
            </div>
            <div class="grid gap-4">
              <ElSkeletonItem variant="rect" class="h-10 w-full" />
              <ElSkeletonItem variant="rect" class="h-10 w-full" />
            </div>
          </section>

          <section class="min-h-0 flex-1 rounded-lg border border-border-a60 p-5">
            <div class="mb-4 flex items-center justify-between gap-4">
              <ElSkeletonItem variant="h3" class="max-w-40" />
              <ElSkeletonItem variant="button" class="h-8 max-w-32" />
            </div>
            <div class="grid gap-3">
              <ElSkeletonItem v-for="row in 5" :key="row" variant="rect" class="h-10 w-full rounded-md" />
            </div>
          </section>
        </main>
      </template>
    </ElSkeleton>

    <template v-else>
      <ProviderSidebar
        v-model:search-keyword="searchKeyword"
        :rows="filteredRows"
        :selected-row-key="selectedRowKey"
        :get-provider-initial="getProviderInitial"
        :get-provider-status-type="getProviderStatusType"
        @select-row="selectRow"
        @open-create-provider="openCreateCompatibleProviderDialog"
        @compatible-command="handleCompatibleProviderCommand"
        @row-context-menu="handleRowContextMenu"
      />

      <ConsoleContent
        :selected-row="selectedRow"
        :selected-title="selectedTitle"
        :selected-provider="selectedProvider"
        :endpoint-form="endpointForm"
        :api-key-form="apiKeyForm"
        :can-edit-endpoint="canEditEndpoint"
        :requires-api-key="requiresApiKey"
        :is-updating-provider-status="isUpdatingProviderStatus"
        :is-saving-endpoint="isSavingEndpoint"
        :is-saving-api-key="isSavingApiKey"
        :is-loading-api-key="isLoadingApiKey"
        :models="models"
        :model-summary-text="modelSummaryText"
        :discover-models-button-text="discoverModelsButtonText"
        :should-show-empty-state="shouldShowModelsEmptyState"
        :is-loading-models="isLoadingModels"
        :is-discovering-models="isDiscoveringModels"
        :is-model-updating="isModelUpdating"
        @update-provider-enabled="updateProviderEnabled"
        @save-endpoint="saveEndpoint"
        @save-api-key="saveApiKey"
        @open-discover-models="openDiscoverModelsDialog"
        @open-create-model="openCreateModelDialog"
        @configure-model="openModelCapabilityDialog"
        @update-model-status="updateModelStatus"
      />

      <CompatibleProviderDialog
        ref="createCompatibleProviderFormRef"
        v-model:visible="createCompatibleProviderDialogVisible"
        mode="create"
        :presets="compatiblePresets"
        :form="compatibleProviderCreateForm"
        :rules="compatibleProviderCreateRules"
        :loading="isCreatingCompatibleProvider"
        @submit="createCompatibleProvider"
      />

      <CompatibleProviderDialog
        ref="editCompatibleProviderFormRef"
        v-model:visible="editCompatibleProviderDialogVisible"
        mode="edit"
        :presets="compatiblePresets"
        :form="compatibleProviderEditForm"
        :rules="compatibleProviderEditRules"
        :loading="isUpdatingCompatibleProvider"
        @submit="updateCompatibleProvider"
      />

      <DiscoverModelsDialog
        v-model:visible="discoverDialogVisible"
        v-model:search-keyword="discoverSearchKeyword"
        :title="selectedTitle"
        :models="filteredDiscoveredModels"
        :is-discovering="isDiscoveringModels"
        :is-adding="isAddingDiscoveredModels"
        :is-model-updating="isModelUpdating"
        @add-all="addAllDiscoveredModels"
        @refresh="refreshDiscoveredModels()"
        @update-model-status="updateModelStatus"
      />

      <CreateModelDialog
        ref="createModelFormRef"
        v-model:visible="createModelDialogVisible"
        :form="createModelForm"
        :rules="createModelRules"
        :loading="isCreatingModel"
        @model-id-input="handleCreateModelIdInput"
        @submit="createModel"
      />

      <ModelCapabilityDialog
        v-model:visible="modelCapabilityDialogVisible"
        :form="modelCapabilityForm"
        :rules="modelCapabilityRules"
        :loading="isSavingModelCapability"
        @submit="saveModelCapability"
      />
    </template>
  </div>
</template>

<style src="./index.scss" lang="scss"></style>
