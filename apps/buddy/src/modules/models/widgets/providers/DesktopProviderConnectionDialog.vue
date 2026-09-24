<script setup lang="ts">
import type { LocalProvider } from '@buddy-shared/providers/providerApi'

import type { ProviderConnectionActions } from './typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { isPlainHttpEndpointUrl } from '@buddy-shared/network/networkSecurity'
import { providerRequestHeadersSchema } from '@buddy-shared/providers/providerHeaders'
import { NAlert, NButton, NCard, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NModal, NSelect } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { desktopProviderApiOptions } from '@/modules/models/model/desktopProviderApiOptions'
import DesktopProviderHeadersEditor from './DesktopProviderHeadersEditor.vue'
import { useProviderConnectionForm } from './useProviderConnectionForm'
import { useProviderFormRules } from './useProviderFormRules'

const props = defineProps<{
  actions: ProviderConnectionActions
  language: BuddyLocale
  provider: LocalProvider
}>()
const show = defineModel<boolean>('show', { required: true })
const { t } = useBuddyI18n(() => props.language)
const { saving, form, close, save } = useProviderConnectionForm(props, show)
const formRef = useTemplateRef('formRef')
const rules = useProviderFormRules(() => props.language)
const expanded = shallowRef<string[]>([])
const insecureBaseUrl = computed(() => isPlainHttpEndpointUrl(form.baseUrl.trim()))
watch(show, () => {
  expanded.value = []
})

async function submit() {
  if (saving.value)
    return
  try {
    if (!providerRequestHeadersSchema.safeParse(form.requestHeaders).success) {
      expanded.value = ['advanced']
      await nextTick()
    }
    await formRef.value?.validate()
  }
  catch {
    return
  }
  await save()
}
</script>

<template>
  <NModal v-model:show="show" :mask-closable="false">
    <NCard
      class="desktop-provider-connection-dialog"
      closable
      :style="{ width: 'min(42rem, calc(100vw - 2rem))' }"
      @close="close"
    >
      <template #header>
        {{ t('desktop.providers.connectionSettings') }}
      </template>

      <NForm ref="formRef" :model="form" :rules="rules" :disabled="saving" class="desktop-provider-connection-dialog__form" @submit.prevent="submit">
        <NFormItem path="displayName" :class="{ 'is-wide': !provider.custom }" :label="t('desktop.providers.displayName')">
          <NInput
            v-model:value="form.displayName"
            :placeholder="t('desktop.providers.displayNamePlaceholder')"
          />
        </NFormItem>
        <NFormItem v-if="provider.custom" :label="t('desktop.providers.identifier')">
          <NInput :value="provider.id" disabled />
        </NFormItem>
        <NFormItem v-if="provider.custom" path="api" :label="t('desktop.providers.apiType')">
          <NSelect
            v-model:value="form.api"
            menu-size="small"
            :options="desktopProviderApiOptions"
          />
        </NFormItem>
        <NFormItem v-if="provider.custom" path="baseUrl" label="Base URL">
          <NInput v-model:value="form.baseUrl" placeholder="https://api.example.com/v1" />
        </NFormItem>
        <NAlert v-if="provider.custom && insecureBaseUrl" class="is-wide" type="warning" :bordered="false" :show-icon="false">
          {{ t('desktop.providers.httpWarning') }}
        </NAlert>
        <NFormItem v-if="provider.custom" path="description" class="is-wide" :label="t('desktop.providers.customProviderDescription')">
          <NInput
            v-model:value="form.description"
            :maxlength="200"
            :placeholder="t('desktop.providers.customProviderDescriptionPlaceholder')"
          />
        </NFormItem>
        <NCollapse v-model:expanded-names="expanded" class="is-wide" arrow-placement="right">
          <NCollapseItem :title="t('desktop.providers.advancedSettings')" name="advanced" display-directive="show">
            <DesktopProviderHeadersEditor v-model:value="form.requestHeaders" :language="language" :disabled="saving" />
          </NCollapseItem>
        </NCollapse>
      </NForm>

      <template #footer>
        <div class="desktop-provider-connection-dialog__actions">
          <NButton :disabled="saving" @click="close">
            {{ t('common.cancel') }}
          </NButton>
          <NButton type="primary" :disabled="saving" :loading="saving" @click="submit">
            {{ t('common.save') }}
          </NButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.desktop-provider-connection-dialog :deep(.n-card__content) {
  display: grid;
  column-gap: 0.9rem;
}

.desktop-provider-connection-dialog { max-height: calc(100dvh - 3rem); }
.desktop-provider-connection-dialog :deep(.n-card__content) { overflow: auto; }

.desktop-provider-connection-dialog__form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.9rem;
  padding: 2px;
}

.desktop-provider-connection-dialog__form .is-wide {
  grid-column: 1 / -1;
}

.desktop-provider-connection-dialog__form :deep(.n-input),
.desktop-provider-connection-dialog__form :deep(.n-base-selection) {
  width: 100%;
}

.desktop-provider-connection-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}

@media (max-width: 700px) {
  .desktop-provider-connection-dialog__form {
    grid-template-columns: minmax(0, 1fr);
  }

  .desktop-provider-connection-dialog__form .is-wide {
    grid-column: auto;
  }
}
</style>
