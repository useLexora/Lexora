<script setup lang="ts">
import type { LocalCustomProvider } from '@buddy-shared/providers/providerApi'
import type { ProviderRequestHeader } from '@buddy-shared/providers/providerHeaders'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { isPlainHttpEndpointUrl } from '@buddy-shared/network/networkSecurity'
import { customProviderSchema } from '@buddy-shared/providers/providerApi'
import { providerRequestHeadersSchema } from '@buddy-shared/providers/providerHeaders'
import { NAlert, NButton, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NSelect } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { desktopProviderApiOptions } from '@/modules/models/model/desktopProviderApiOptions'
import DesktopProviderHeadersEditor from './DesktopProviderHeadersEditor.vue'
import { useProviderFormRules } from './useProviderFormRules'

interface CustomForm {
  api: LocalCustomProvider['api']
  baseUrl: string
  description: string
  displayName: string
  id: string
  requestHeaders: ProviderRequestHeader[]
}

const props = defineProps<{
  value: CustomForm
  language: BuddyLocale
  reservedIds: readonly string[]
  conflictId: string | null
  identifierLocked: boolean
  saving: boolean
}>()
const emit = defineEmits<{
  'update:value': [value: CustomForm]
  'submit': []
}>()
const { t } = useBuddyI18n(() => props.language)
const form = useTemplateRef('form')
const expanded = shallowRef<string[]>([])
const validating = shallowRef(false)
const identifierAvailable = (id: string) => !props.reservedIds.includes(id) && props.conflictId !== id
const rules = useProviderFormRules(() => props.language, identifierAvailable)
const insecureBaseUrl = computed(() => isPlainHttpEndpointUrl(props.value.baseUrl.trim()))

function update<Key extends keyof CustomForm>(field: Key, value: CustomForm[Key]) {
  emit('update:value', { ...props.value, [field]: value })
}

async function submit() {
  if (props.saving || validating.value)
    return
  validating.value = true
  try {
    if (!customProviderSchema.shape.id.safeParse(props.value.id).success || !identifierAvailable(props.value.id.trim()) || !providerRequestHeadersSchema.safeParse(props.value.requestHeaders).success) {
      expanded.value = ['advanced']
      await nextTick()
    }
    await form.value?.validate()
    emit('submit')
  }
  catch {}
  finally {
    validating.value = false
  }
}

watch(() => props.conflictId, async (id) => {
  if (!id || id !== props.value.id.trim())
    return
  expanded.value = ['advanced']
  await nextTick()
  await form.value?.validate(undefined, rule => rule.key === 'id').catch(() => {})
})
</script>

<template>
  <NForm ref="form" :model="value" :rules="rules" :disabled="saving" class="desktop-custom-provider-form" @submit.prevent="submit">
    <NFormItem path="displayName" :label="t('desktop.providers.displayName')">
      <NInput :value="value.displayName" :placeholder="t('desktop.providers.displayNamePlaceholder')" @update:value="update('displayName', $event)" />
    </NFormItem>
    <NFormItem path="api" :label="t('desktop.providers.apiType')">
      <NSelect :value="value.api" :options="desktopProviderApiOptions" menu-size="small" @update:value="update('api', $event)" />
    </NFormItem>
    <NFormItem path="description" class="is-wide" :label="t('desktop.providers.customProviderDescription')">
      <NInput :value="value.description" :maxlength="200" :placeholder="t('desktop.providers.customProviderDescriptionPlaceholder')" @update:value="update('description', $event)" />
    </NFormItem>
    <NFormItem path="baseUrl" class="is-wide" label="Base URL">
      <NInput :value="value.baseUrl" placeholder="https://api.example.com/v1" @update:value="update('baseUrl', $event)" />
    </NFormItem>
    <NAlert v-if="insecureBaseUrl" class="desktop-custom-provider-form__http-warning is-wide" type="warning" :bordered="false" :show-icon="false">
      {{ t('desktop.providers.httpWarning') }}
    </NAlert>
    <NCollapse v-model:expanded-names="expanded" class="is-wide" arrow-placement="right">
      <NCollapseItem :title="t('desktop.providers.advancedSettings')" name="advanced" display-directive="show">
        <NFormItem path="id" :label="t('desktop.providers.identifier')">
          <NInput :value="value.id" :disabled="identifierLocked" @update:value="update('id', $event)" />
        </NFormItem>
        <DesktopProviderHeadersEditor :value="value.requestHeaders" :language="language" :disabled="saving" @update:value="update('requestHeaders', $event)" />
      </NCollapseItem>
    </NCollapse>
    <div class="desktop-custom-provider-form__actions is-wide">
      <NButton attr-type="submit" type="primary" :loading="saving" :disabled="saving || validating">
        {{ t('desktop.providers.continue') }}
      </NButton>
    </div>
  </NForm>
</template>

<style scoped>
.desktop-custom-provider-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 0.9rem;
  padding: 2px;
}
.is-wide { grid-column: 1 / -1; }
.desktop-custom-provider-form__http-warning { margin-bottom: 1.5rem; }
.desktop-custom-provider-form__actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 0.9rem;
}
@media (max-width: 700px) {
  .desktop-custom-provider-form { grid-template-columns: minmax(0, 1fr); }
}
</style>
