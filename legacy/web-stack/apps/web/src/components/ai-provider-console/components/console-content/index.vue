<script setup lang="ts">
import type {
  AiProviderConsoleContentEmits,
  AiProviderConsoleContentProps,
} from './typing'
import ModelsPanel from '../models-panel'
import ProviderOverview from '../provider-overview'

const props = defineProps<AiProviderConsoleContentProps>()
const emits = defineEmits<AiProviderConsoleContentEmits>()
</script>

<template>
  <main class="ai-provider-console__main flex min-h-0 min-w-0 flex-col overflow-hidden p-4 max-[1023px]:p-4">
    <template v-if="props.selectedRow">
      <ProviderOverview
        :selected-title="props.selectedTitle"
        :selected-provider="props.selectedProvider"
        :endpoint-form="props.endpointForm"
        :api-key-form="props.apiKeyForm"
        :can-edit-endpoint="props.canEditEndpoint"
        :requires-api-key="props.requiresApiKey"
        :is-updating-provider-status="props.isUpdatingProviderStatus"
        :is-saving-endpoint="props.isSavingEndpoint"
        :is-saving-api-key="props.isSavingApiKey"
        :is-loading-api-key="props.isLoadingApiKey"
        @update-provider-enabled="emits('updateProviderEnabled', $event)"
        @save-endpoint="emits('saveEndpoint')"
        @save-api-key="emits('saveApiKey')"
      />

      <ModelsPanel
        :models="props.models"
        :model-summary-text="props.modelSummaryText"
        :discover-models-button-text="props.discoverModelsButtonText"
        :should-show-empty-state="props.shouldShowEmptyState"
        :is-loading-models="props.isLoadingModels"
        :is-discovering-models="props.isDiscoveringModels"
        :is-model-updating="props.isModelUpdating"
        @open-discover-models="emits('openDiscoverModels')"
        @open-create-model="emits('openCreateModel')"
        @configure-model="model => emits('configureModel', model)"
        @update-model-status="(model, value) => emits('updateModelStatus', model, value)"
      />
    </template>
  </main>
</template>
