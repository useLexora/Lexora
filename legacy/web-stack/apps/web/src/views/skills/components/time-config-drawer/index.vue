<script setup lang="ts">
import type { AgentSkillCard, AgentTimeSkillConfig } from '@haohaoxue/lexora-contracts/agent'
import type { FormInstance, FormRules } from 'element-plus'
import type { TimeConfigFormModel } from '../../utils/time'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createTimeConfigFormModel,
  getDetectedBrowserTimeZone,
  isTimeZoneFormValueValid,
  toTimeSkillConfig,
} from '../../utils/time'

const props = defineProps<{
  skill: AgentSkillCard | null
  saving: boolean
}>()
const emit = defineEmits<{
  submit: [config: AgentTimeSkillConfig]
}>()
const { t } = useI18n()
const visible = defineModel<boolean>('visible', { required: true })
const formRef = ref<FormInstance>()
const formModel = reactive(createTimeConfigFormModel(null))
const detectedTimeZone = shallowRef<string | null>(null)
const submitActionText = computed(() => props.skill?.installed === false ? t('skills.install') : t('docs.common.save'))
const rules = computed<FormRules<TimeConfigFormModel>>(() => ({
  timeZone: [
    {
      validator: validateTimeZone,
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

    detectedTimeZone.value = getDetectedBrowserTimeZone()
    Object.assign(formModel, createTimeConfigFormModel(props.skill?.config ?? null))
  },
  { immediate: true },
)

async function handleSubmit() {
  await formRef.value?.validate()
  emit('submit', toTimeSkillConfig(formModel))
}

function handleUseDetectedTimeZone() {
  if (!detectedTimeZone.value) {
    return
  }

  formModel.timeZone = detectedTimeZone.value
}

function validateTimeZone(_rule: unknown, value: unknown, callback: (error?: Error) => void) {
  const text = typeof value === 'string' ? value : ''
  if (isTimeZoneFormValueValid(text)) {
    callback()
    return
  }

  callback(new Error(t('skills.time.timeZoneRule')))
}
</script>

<template>
  <ElDrawer
    v-model="visible"
    :title="t('skills.time.title')"
    size="32rem"
    destroy-on-close
  >
    <ElForm
      ref="formRef"
      :model="formModel"
      :rules="rules"
      label-position="top"
      class="time-config-form"
    >
      <ElFormItem :label="t('skills.time.timeZone')" prop="timeZone">
        <ElInput
          v-model="formModel.timeZone"
          :placeholder="t('skills.time.timeZonePlaceholder')"
          clearable
        >
          <template v-if="detectedTimeZone" #append>
            <ElButton @click="handleUseDetectedTimeZone">
              {{ t('skills.time.useBrowserTimeZone') }}
            </ElButton>
          </template>
        </ElInput>
        <p class="m-0 mt-2 text-xs leading-5 text-[var(--brand-text-tertiary)]">
          {{ t('skills.time.unconfiguredHint') }}
        </p>
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
