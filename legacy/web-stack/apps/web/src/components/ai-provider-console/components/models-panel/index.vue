<script setup lang="ts">
import type { AiProviderModelsPanelEmits, AiProviderModelsPanelProps } from './typing'
import { useI18n } from 'vue-i18n'
import Empty from '@/components/empty'
import { LoadingTableSkeleton } from '@/components/loading'
import ProviderModelTable from '../model-table'

defineProps<AiProviderModelsPanelProps>()

const emit = defineEmits<AiProviderModelsPanelEmits>()
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <section class="ai-provider-console__section ai-provider-console__section--models">
    <div class="ai-provider-console__section-header ai-provider-console__section-header--models">
      <h3 class="m-0 text-base font-semibold text-main">
        {{ t('aiProvider.model.modelList') }}
      </h3>
      <span class="ai-provider-console__section-summary ml-1">
        {{ modelSummaryText }}
      </span>
      <ElButtonGroup class="ai-provider-console__section-action">
        <ElButton
          type="primary"
          plain
          :loading="isDiscoveringModels"
          @click="emit('openDiscoverModels')"
        >
          <SvgIcon category="ui" icon="sync-refresh" size="1rem" class="mr-2" />
          {{ discoverModelsButtonText }}
        </ElButton>
        <ElTooltip :content="t('aiProvider.common.addModel')" placement="top" effect="light">
          <ElButton
            type="primary"
            plain
            :aria-label="t('aiProvider.common.addModel')"
            @click="emit('openCreateModel')"
          >
            <SvgIcon category="ui" icon="plus" size="1rem" />
          </ElButton>
        </ElTooltip>
      </ElButtonGroup>
    </div>

    <div v-if="shouldShowEmptyState" class="ai-provider-console__models-empty">
      <Empty compact :description="t('aiProvider.model.empty')" />
    </div>

    <div v-else class="ai-provider-console__model-list">
      <LoadingTableSkeleton v-if="isLoadingModels" />

      <ProviderModelTable
        v-else
        :models="models"
        :can-configure="true"
        :is-model-updating="isModelUpdating"
        @configure-model="model => emit('configureModel', model)"
        @update-model-status="(model, value) => emit('updateModelStatus', model, value)"
      />
    </div>
  </section>
</template>
