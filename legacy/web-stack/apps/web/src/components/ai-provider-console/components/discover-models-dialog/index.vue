<script setup lang="ts">
import type {
  AiProviderDiscoverModelsDialogEmits,
  AiProviderDiscoverModelsDialogProps,
} from './typing'
import { useI18n } from 'vue-i18n'
import { LoadingTableSkeleton } from '@/components/loading'
import ProviderModelTable from '../model-table'

defineProps<AiProviderDiscoverModelsDialogProps>()

const emit = defineEmits<AiProviderDiscoverModelsDialogEmits>()
const visible = defineModel<boolean>('visible', { required: true })
const searchKeyword = defineModel<string>('searchKeyword', { required: true })
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <ElDialog
    v-model="visible"
    :title="t('aiProvider.discover.title', { title })"
    width="min(72rem, calc(100vw - 4rem))"
    class="ai-provider-console__discover-dialog"
  >
    <div class="ai-provider-console__discover-toolbar">
      <ElInput
        v-model="searchKeyword"
        clearable
        class="ai-provider-console__discover-search"
        :placeholder="t('aiProvider.discover.searchPlaceholder')"
      />
      <div class="ai-provider-console__discover-actions">
        <ElButton
          type="primary"
          :loading="isAdding"
          :disabled="models.length === 0"
          @click="emit('addAll')"
        >
          {{ t('aiProvider.discover.addAll') }}
        </ElButton>
        <ElButton :loading="isDiscovering" @click="emit('refresh')">
          <SvgIcon category="ui" icon="sync-refresh" size="1rem" class="mr-2" />
          {{ t('aiProvider.discover.refresh') }}
        </ElButton>
      </div>
    </div>

    <div class="ai-provider-console__discover-list">
      <LoadingTableSkeleton v-if="isDiscovering && models.length === 0" />

      <ProviderModelTable
        v-else
        :models="models"
        :can-configure="false"
        :is-model-updating="isModelUpdating"
        @update-model-status="(model, value) => emit('updateModelStatus', model, value)"
      />
    </div>
  </ElDialog>
</template>
