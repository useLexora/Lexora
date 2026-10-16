<script setup lang="ts">
import type { AgentSkillCard, AgentTranslatorSkillConfig } from '@haohaoxue/lexora-contracts'
import type { FormInstance } from 'element-plus'
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createTranslatorConfigFormModel,
  createTranslatorFormalityOptions,
  createTranslatorOutputModeOptions,
  toTranslatorSkillConfig,
} from '../../utils/translator'

const props = defineProps<{
  skill: AgentSkillCard | null
  saving: boolean
}>()
const emit = defineEmits<{
  submit: [config: AgentTranslatorSkillConfig]
}>()
const { t } = useI18n()
const visible = defineModel<boolean>('visible', { required: true })
const formRef = ref<FormInstance>()
const formModel = reactive(createTranslatorConfigFormModel(null))
const outputModeOptions = computed(() => createTranslatorOutputModeOptions(t))
const formalityOptions = computed(() => createTranslatorFormalityOptions(t))
const submitActionText = computed(() => props.skill?.installed === false ? t('skills.install') : t('docs.common.save'))

watch(
  () => [props.skill?.key, props.skill?.config, visible.value] as const,
  () => {
    if (!visible.value) {
      return
    }

    Object.assign(formModel, createTranslatorConfigFormModel(props.skill?.config ?? null))
  },
  { immediate: true },
)

async function handleSubmit() {
  await formRef.value?.validate()
  emit('submit', toTranslatorSkillConfig(formModel))
}
</script>

<template>
  <ElDrawer
    v-model="visible"
    :title="t('skills.translator.title')"
    size="32rem"
    destroy-on-close
  >
    <ElForm
      ref="formRef"
      :model="formModel"
      label-position="top"
      class="translator-config-form"
    >
      <ElFormItem :label="t('skills.translator.outputMode')">
        <ElSegmented v-model="formModel.outputMode" :options="outputModeOptions" block class="w-full" />
      </ElFormItem>

      <ElFormItem :label="t('skills.translator.formality')">
        <ElSegmented v-model="formModel.formality" :options="formalityOptions" block class="w-full" />
      </ElFormItem>

      <ElFormItem>
        <ElCheckbox v-model="formModel.preserveFormatting">
          {{ t('skills.translator.preserveFormatting') }}
        </ElCheckbox>
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
