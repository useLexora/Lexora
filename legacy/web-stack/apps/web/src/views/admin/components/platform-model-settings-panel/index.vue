<script setup lang="ts">
import type {
  PlatformModelSettingsPanelEmits,
  PlatformModelSettingsPanelProps,
} from './typing'
import type { AiProviderScope } from '@/apis/ai'
import { AI_MODEL_INTENT_KEY, AI_PROVIDER_SCOPE } from '@haohaoxue/lexora-contracts/ai/constants'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getPlatformEmbeddingAvailableAiProviderModels,
  getPlatformEmbeddingAvailableAiProviders,
} from '@/apis/ai'
import ModelCascader from '@/components/model-cascader'

const props = defineProps<PlatformModelSettingsPanelProps>()
const emits = defineEmits<PlatformModelSettingsPanelEmits>()
const { t } = useI18n({ useScope: 'global' })
const PLATFORM_MODEL_SCOPES: AiProviderScope[] = [AI_PROVIDER_SCOPE.PLATFORM]

const panelVisible = computed({
  get: () => props.visible,
  set: value => emits('update:visible', value),
})
</script>

<template>
  <ElDrawer
    v-model="panelVisible"
    :title="t('admin.platformModel.title')"
    size="28rem"
    append-to-body
    destroy-on-close
    class="admin-platform-model-settings-drawer"
  >
    <div class="admin-platform-model-settings">
      <ElSkeleton v-if="props.loading" animated>
        <template #template>
          <section class="grid gap-3">
            <div class="flex items-center justify-between gap-3">
              <ElSkeletonItem variant="h3" class="max-w-36" />
              <ElSkeletonItem variant="button" class="h-6 max-w-16" />
            </div>
            <ElSkeletonItem variant="rect" class="h-10 w-full" />
            <ElSkeletonItem variant="text" class="max-w-64" />
          </section>
        </template>
      </ElSkeleton>

      <section v-else class="admin-platform-model-settings__section">
        <div class="admin-platform-model-settings__header">
          <div class="admin-platform-model-settings__label">
            {{ t('admin.platformModel.embeddingModel') }}
          </div>
          <ElTag v-if="props.modelPolicy?.invalidReason" type="danger" effect="plain" size="small">
            {{ t('admin.platformModel.abnormal') }}
          </ElTag>
        </div>
        <ModelCascader
          :model-value="props.modelRef"
          :intent-key="AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT"
          :allowed-scopes="PLATFORM_MODEL_SCOPES"
          :available-providers-loader="getPlatformEmbeddingAvailableAiProviders"
          :available-provider-models-loader="getPlatformEmbeddingAvailableAiProviderModels"
          :hide-unavailable="true"
          :clearable="true"
          :filterable="true"
          :show-all-levels="false"
          :disabled="props.loading || props.saving"
          :placeholder="t('admin.platformModel.placeholder')"
          @update:model-value="value => emits('updateModel', value)"
        />
        <p v-if="props.modelPolicy?.invalidReason" class="admin-platform-model-settings__error">
          {{ props.modelPolicy.invalidReason }}
        </p>
      </section>
    </div>
  </ElDrawer>
</template>

<style scoped lang="scss">
.admin-platform-model-settings {
  min-height: 10rem;
  padding: 1rem;
}

.admin-platform-model-settings__section {
  display: grid;
  gap: 0.625rem;
}

.admin-platform-model-settings__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.admin-platform-model-settings__label {
  color: var(--brand-text-primary);
  font-size: 0.875rem;
  font-weight: 700;
}

.admin-platform-model-settings__error {
  margin: 0;
  color: var(--el-color-danger);
  font-size: 0.8125rem;
  line-height: 1.5;
}

:deep(.el-drawer__body) {
  padding: 0;
}

@media (max-width: 640px) {
  :global(.admin-platform-model-settings-drawer) {
    width: min(100vw, 28rem) !important;
  }
}
</style>
