<script setup lang="ts">
import type { FormInstance } from 'element-plus'
import type { AiProviderFormController } from '../../typing'
import type {
  AiProviderCreateModelDialogEmits,
  AiProviderCreateModelDialogProps,
} from './typing'
import {
  AI_MODEL_CAPABILITY,
  AI_MODEL_CAPABILITY_VALUES,
  AI_MODEL_MODALITY,
  AI_MODEL_MODALITY_VALUES,
  AI_MODEL_TYPE,
  AI_MODEL_TYPE_VALUES,
} from '@haohaoxue/lexora-contracts/ai/constants'
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

defineProps<AiProviderCreateModelDialogProps>()

const emit = defineEmits<AiProviderCreateModelDialogEmits>()
const visible = defineModel<boolean>('visible', { required: true })
const formRef = useTemplateRef<FormInstance>('formRef')
const { t } = useI18n({ useScope: 'global' })
const modelTypeOptions = computed(() => AI_MODEL_TYPE_VALUES.map(value => ({
  label: getModelTypeLabel(value),
  value,
})))
const modelModalityOptions = computed(() => AI_MODEL_MODALITY_VALUES.map(value => ({
  label: getModelModalityLabel(value),
  value,
})))
const modelCapabilityOptions = computed(() => AI_MODEL_CAPABILITY_VALUES.map(value => ({
  label: getModelCapabilityLabel(value),
  value,
})))

function getModelTypeLabel(value: typeof AI_MODEL_TYPE_VALUES[number]) {
  const keyMap = {
    [AI_MODEL_TYPE.CHAT]: 'aiProvider.modelType.chat',
    [AI_MODEL_TYPE.EMBEDDING]: 'aiProvider.modelType.embedding',
    [AI_MODEL_TYPE.RERANK]: 'aiProvider.modelType.rerank',
    [AI_MODEL_TYPE.IMAGE]: 'aiProvider.modelType.image',
    [AI_MODEL_TYPE.AUDIO]: 'aiProvider.modelType.audio',
  } as const

  return t(keyMap[value])
}

function getModelModalityLabel(value: typeof AI_MODEL_MODALITY_VALUES[number]) {
  const keyMap = {
    [AI_MODEL_MODALITY.TEXT]: 'aiProvider.modality.text',
    [AI_MODEL_MODALITY.IMAGE]: 'aiProvider.modality.image',
    [AI_MODEL_MODALITY.AUDIO]: 'aiProvider.modality.audio',
    [AI_MODEL_MODALITY.VIDEO]: 'aiProvider.modality.video',
    [AI_MODEL_MODALITY.FILE]: 'aiProvider.modality.file',
    [AI_MODEL_MODALITY.EMBEDDING]: 'aiProvider.modality.embedding',
  } as const

  return t(keyMap[value])
}

function getModelCapabilityLabel(value: typeof AI_MODEL_CAPABILITY_VALUES[number]) {
  const keyMap = {
    [AI_MODEL_CAPABILITY.STREAMING]: 'aiProvider.capability.streaming',
    [AI_MODEL_CAPABILITY.TOOL_CALL]: 'aiProvider.capability.toolCall',
    [AI_MODEL_CAPABILITY.REASONING]: 'aiProvider.capability.reasoning',
    [AI_MODEL_CAPABILITY.JSON_MODE]: 'aiProvider.capability.jsonMode',
    [AI_MODEL_CAPABILITY.STRUCTURED_OUTPUT]: 'aiProvider.capability.structuredOutput',
  } as const

  return t(keyMap[value])
}

async function validate() {
  return await formRef.value?.validate().catch(() => false) ?? false
}

function clearValidate() {
  formRef.value?.clearValidate()
}

defineExpose<AiProviderFormController>({
  validate,
  clearValidate,
})
</script>

<template>
  <ElDialog v-model="visible" :title="t('aiProvider.common.addModel')" width="42rem">
    <ElForm
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="7rem"
    >
      <ElFormItem :label="t('aiProvider.model.modelId')" prop="modelId" required>
        <ElInput
          :model-value="form.modelId"
          :placeholder="t('aiProvider.model.modelIdPlaceholder')"
          @input="value => emit('modelIdInput', String(value))"
        />
      </ElFormItem>
      <ElFormItem :label="t('aiProvider.model.modelName')" prop="modelName">
        <ElInput v-model="form.modelName" :placeholder="t('aiProvider.model.modelNamePlaceholder')" />
      </ElFormItem>
      <ElFormItem :label="t('aiProvider.model.type')" prop="modelType">
        <ElSelect v-model="form.modelType" class="w-full">
          <ElOption
            v-for="option in modelTypeOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </ElSelect>
      </ElFormItem>
      <ElFormItem :label="t('aiProvider.model.inputModalities')" prop="inputModalities">
        <ElCheckboxGroup v-model="form.inputModalities" class="ai-provider-console__checkbox-grid">
          <ElCheckbox
            v-for="option in modelModalityOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </ElCheckbox>
        </ElCheckboxGroup>
      </ElFormItem>
      <ElFormItem :label="t('aiProvider.model.outputModalities')" prop="outputModalities">
        <ElCheckboxGroup v-model="form.outputModalities" class="ai-provider-console__checkbox-grid">
          <ElCheckbox
            v-for="option in modelModalityOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </ElCheckbox>
        </ElCheckboxGroup>
      </ElFormItem>
      <ElFormItem :label="t('aiProvider.model.capabilities')" prop="capabilities">
        <ElCheckboxGroup v-model="form.capabilities" class="ai-provider-console__checkbox-grid">
          <ElCheckbox
            v-for="option in modelCapabilityOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </ElCheckbox>
        </ElCheckboxGroup>
      </ElFormItem>
      <div class="ai-provider-console__model-limit-grid">
        <ElFormItem :label="t('aiProvider.model.contextWindow')" prop="contextWindow">
          <ElInputNumber
            v-model="form.contextWindow"
            :min="1"
            :precision="0"
            controls-position="right"
            class="w-full"
            :placeholder="t('aiProvider.model.unconfigured')"
          />
        </ElFormItem>
        <ElFormItem :label="t('aiProvider.model.maxOutput')" prop="maxOutputTokens">
          <ElInputNumber
            v-model="form.maxOutputTokens"
            :min="1"
            :precision="0"
            controls-position="right"
            class="w-full"
            :placeholder="t('aiProvider.model.unconfigured')"
          />
        </ElFormItem>
      </div>
    </ElForm>

    <template #footer>
      <ElButton @click="visible = false">
        {{ t('aiProvider.common.cancel') }}
      </ElButton>
      <ElButton type="primary" :loading="loading" @click="emit('submit')">
        {{ t('aiProvider.common.addModel') }}
      </ElButton>
    </template>
  </ElDialog>
</template>
