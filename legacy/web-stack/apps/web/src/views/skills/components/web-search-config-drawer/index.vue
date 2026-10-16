<script setup lang="ts">
import type { AgentSkillCard, AgentWebSearchSkillConfig } from '@haohaoxue/lexora-contracts/agent'
import type { FormInstance, FormRules } from 'element-plus'
import type { WebSearchConfigFormModel } from '../../utils/web-search'
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createWebSearchConfigFormModel,
  createWebSearchContextSizeOptions,
  createWebSearchProviderOptions,
  isWebSearchDomainTextValid,
  toWebSearchSkillConfig,
} from '../../utils/web-search'

const props = defineProps<{
  skill: AgentSkillCard | null
  saving: boolean
}>()
const emit = defineEmits<{
  submit: [config: AgentWebSearchSkillConfig]
}>()
const { t } = useI18n()
const visible = defineModel<boolean>('visible', { required: true })
const formRef = ref<FormInstance>()
const formModel = reactive(createWebSearchConfigFormModel(null))
const providerOptions = computed(() => createWebSearchProviderOptions(t))
const contextSizeOptions = computed(() => createWebSearchContextSizeOptions(t))
const submitActionText = computed(() => props.skill?.installed === false ? t('skills.install') : t('docs.common.save'))
const rules = computed<FormRules<WebSearchConfigFormModel>>(() => ({
  providers: [
    {
      type: 'array',
      required: true,
      min: 1,
      message: t('skills.webSearch.providerRequired'),
      trigger: 'change',
    },
  ],
  maxResults: [
    {
      type: 'number',
      required: true,
      min: 1,
      max: 10,
      message: t('skills.webSearch.maxResultsRule'),
      trigger: 'change',
    },
  ],
  allowedDomainsText: [
    {
      validator: validateDomainText,
      trigger: 'blur',
    },
  ],
  blockedDomainsText: [
    {
      validator: validateDomainText,
      trigger: 'blur',
    },
  ],
}))

watch(
  () => [props.skill?.key, props.skill?.config, visible.value] as const,
  () => {
    if (!visible.value) {
      return
    }

    Object.assign(formModel, createWebSearchConfigFormModel(props.skill?.config ?? null))
  },
  { immediate: true },
)

async function handleSubmit() {
  await formRef.value?.validate()
  emit('submit', toWebSearchSkillConfig(formModel))
}

function validateDomainText(_rule: unknown, value: unknown, callback: (error?: Error) => void) {
  const text = typeof value === 'string' ? value : ''
  if (isWebSearchDomainTextValid(text)) {
    callback()
    return
  }

  callback(new Error(t('skills.webSearch.domainRule')))
}
</script>

<template>
  <ElDrawer
    v-model="visible"
    :title="t('skills.webSearch.title')"
    size="34rem"
    destroy-on-close
  >
    <ElForm
      ref="formRef"
      :model="formModel"
      :rules="rules"
      label-position="top"
      class="web-search-config-form"
    >
      <ElFormItem :label="t('skills.webSearch.providers')" prop="providers">
        <ElCheckboxGroup v-model="formModel.providers" class="w-full grid grid-cols-3 gap-x-4 gap-y-2">
          <ElCheckbox
            v-for="option in providerOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </ElCheckbox>
        </ElCheckboxGroup>
      </ElFormItem>

      <ElFormItem :label="t('skills.webSearch.maxResults')" prop="maxResults">
        <ElInputNumber
          v-model="formModel.maxResults"
          :min="1"
          :max="10"
          :precision="0"
          controls-position="right"
          class="w-full"
        />
      </ElFormItem>

      <ElFormItem :label="t('skills.webSearch.searchContextSize')" prop="searchContextSize">
        <ElSegmented v-model="formModel.searchContextSize" :options="contextSizeOptions" block class="w-full" />
      </ElFormItem>

      <ElFormItem :label="t('skills.webSearch.allowedDomains')" prop="allowedDomainsText">
        <ElInput
          v-model="formModel.allowedDomainsText"
          type="textarea"
          :rows="3"
          :placeholder="t('skills.webSearch.allowedDomainsPlaceholder')"
        />
      </ElFormItem>

      <ElFormItem :label="t('skills.webSearch.blockedDomains')" prop="blockedDomainsText">
        <ElInput
          v-model="formModel.blockedDomainsText"
          type="textarea"
          :rows="3"
          :placeholder="t('skills.webSearch.blockedDomainsPlaceholder')"
        />
      </ElFormItem>
    </ElForm>

    <template #footer>
      <div class="flex justify-end gap-2">
        <ElButton :disabled="saving" @click="visible = false">
          {{ t('docs.common.cancel') }}
        </ElButton>
        <ElButton type="primary" :loading="saving" @click="handleSubmit">
          {{ submitActionText }}
        </ElButton>
      </div>
    </template>
  </ElDrawer>
</template>
