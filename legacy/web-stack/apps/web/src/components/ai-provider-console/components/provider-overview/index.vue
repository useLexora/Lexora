<script setup lang="ts">
import type { AiProviderOverviewEmits, AiProviderOverviewProps } from './typing'
import { useI18n } from 'vue-i18n'

defineProps<AiProviderOverviewProps>()

const emit = defineEmits<AiProviderOverviewEmits>()
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <section class="ai-provider-console__overview">
    <div class="ai-provider-console__overview-header">
      <h2 class="m-0 truncate text-xl font-bold text-main">
        {{ selectedTitle }}
      </h2>
      <ElSwitch
        :model-value="selectedProvider?.enabled ?? false"
        :loading="isUpdatingProviderStatus"
        :disabled="isUpdatingProviderStatus"
        @change="value => emit('updateProviderEnabled', value)"
      />
    </div>

    <div class="ai-provider-console__overview-form">
      <div v-if="canEditEndpoint" class="ai-provider-console__field">
        <div class="ai-provider-console__field-label">
          {{ t('aiProvider.overview.apiEndpoint') }}
        </div>
        <ElInput
          v-model="endpointForm.endpoint"
          placeholder="https://api.example.com/v1"
          :disabled="isSavingEndpoint"
          @change="emit('saveEndpoint')"
        />
      </div>
      <div v-if="requiresApiKey" class="ai-provider-console__field">
        <div class="ai-provider-console__field-label">
          API Key
        </div>
        <div class="ai-provider-console__field-row">
          <ElInput
            v-model="apiKeyForm.apiKey"
            class="min-w-0 flex-1"
            type="password"
            show-password
            autocomplete="new-password"
            :placeholder="t('aiProvider.overview.apiKeyPlaceholder')"
            :disabled="isLoadingApiKey || isSavingApiKey"
            @keyup.enter="emit('saveApiKey')"
          />
          <ElButton
            type="primary"
            :loading="isSavingApiKey"
            :disabled="isLoadingApiKey"
            @click="emit('saveApiKey')"
          >
            {{ t('aiProvider.common.save') }}
          </ElButton>
        </div>
      </div>
    </div>
  </section>
</template>
