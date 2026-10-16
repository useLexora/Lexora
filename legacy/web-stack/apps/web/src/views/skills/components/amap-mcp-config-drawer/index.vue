<script setup lang="ts">
import type { AgentAmapMcpSkillCredentialConfig, AgentSkillCard } from '@haohaoxue/lexora-contracts/agent'
import type { FormInstance, FormRules } from 'element-plus'
import type { AmapMcpConfigFormModel } from '../../utils/amap'
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createAmapMcpConfigFormModel,
  toAmapMcpSkillConfig,
} from '../../utils/amap'

const props = defineProps<{
  skill: AgentSkillCard | null
  saving: boolean
}>()
const emit = defineEmits<{
  submit: [config: AgentAmapMcpSkillCredentialConfig]
}>()
const { t } = useI18n()
const visible = defineModel<boolean>('visible', { required: true })
const formRef = ref<FormInstance>()
const formModel = reactive(createAmapMcpConfigFormModel(null))
const submitActionText = computed(() => props.skill?.installed === false ? t('skills.install') : t('docs.common.save'))
const apiKeyRequired = computed(() => props.skill?.installed === false || !formModel.apiKeyConfigured)
const rules = computed<FormRules<AmapMcpConfigFormModel>>(() => ({
  apiKey: [
    {
      validator(_rule, value, callback) {
        if (!apiKeyRequired.value || (typeof value === 'string' && value.trim())) {
          callback()
          return
        }

        callback(new Error(t('skills.amap.apiKeyRule')))
      },
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

    Object.assign(formModel, createAmapMcpConfigFormModel(props.skill?.config ?? null))
  },
  { immediate: true },
)

async function handleSubmit() {
  await formRef.value?.validate()
  emit('submit', toAmapMcpSkillConfig(formModel))
}
</script>

<template>
  <ElDrawer
    v-model="visible"
    :title="t('skills.amap.title')"
    size="30rem"
    destroy-on-close
  >
    <ElForm
      ref="formRef"
      :model="formModel"
      :rules="rules"
      label-position="top"
      class="amap-mcp-config-form"
    >
      <ElFormItem :label="t('skills.amap.apiKey')" prop="apiKey">
        <ElInput
          v-model="formModel.apiKey"
          type="password"
          show-password
          autocomplete="off"
          :placeholder="t('skills.amap.apiKeyPlaceholder')"
        />
      </ElFormItem>

      <p class="m-0 text-sm leading-6 text-[var(--brand-text-secondary)]">
        {{ t('skills.amap.apiKeyHint') }}
      </p>
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
