<script setup lang="ts">
import type { AgentLocationSkillConfig, AgentSkillCard } from '@haohaoxue/lexora-contracts/agent'
import type { FormInstance, FormRules } from 'element-plus'
import type { LocationConfigFormModel } from '../../utils/location'
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createLocationConfigFormModel,
  isLocationFormModelValid,
  toLocationSkillConfig,
} from '../../utils/location'

const props = defineProps<{
  skill: AgentSkillCard | null
  saving: boolean
}>()
const emit = defineEmits<{
  submit: [config: AgentLocationSkillConfig]
}>()
const { t } = useI18n()
const visible = defineModel<boolean>('visible', { required: true })
const formRef = ref<FormInstance>()
const formModel = reactive(createLocationConfigFormModel(null))
const submitActionText = computed(() => props.skill?.installed === false ? t('skills.install') : t('docs.common.save'))
const rules = computed<FormRules<LocationConfigFormModel>>(() => ({
  fixedLocationLabel: [
    {
      validator: validateLocation,
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

    Object.assign(formModel, createLocationConfigFormModel(props.skill?.config ?? null))
  },
  { immediate: true },
)

async function handleSubmit() {
  await formRef.value?.validate()
  emit('submit', toLocationSkillConfig(formModel))
}

function validateLocation(_rule: unknown, _value: unknown, callback: (error?: Error) => void) {
  if (isLocationFormModelValid(formModel)) {
    callback()
    return
  }

  callback(new Error(t('skills.location.locationRule')))
}
</script>

<template>
  <ElDrawer
    v-model="visible"
    :title="t('skills.location.title')"
    size="32rem"
    destroy-on-close
  >
    <ElForm
      ref="formRef"
      :model="formModel"
      :rules="rules"
      label-position="top"
      class="location-config-form"
    >
      <ElFormItem :label="t('skills.location.mode')" prop="mode">
        <ElRadioGroup v-model="formModel.mode">
          <ElRadioButton value="auto">
            {{ t('skills.location.modeAuto') }}
          </ElRadioButton>
          <ElRadioButton value="fixed">
            {{ t('skills.location.modeFixed') }}
          </ElRadioButton>
        </ElRadioGroup>
      </ElFormItem>

      <ElFormItem
        v-if="formModel.mode === 'fixed'"
        :label="t('skills.location.fixedLocation')"
        prop="fixedLocationLabel"
      >
        <ElInput
          v-model="formModel.fixedLocationLabel"
          :placeholder="t('skills.location.fixedLocationPlaceholder')"
          clearable
        />
        <p class="m-0 mt-2 text-xs leading-5 text-[var(--brand-text-tertiary)]">
          {{ t('skills.location.fixedLocationHint') }}
        </p>
      </ElFormItem>

      <p
        v-else
        class="m-0 text-xs leading-5 text-[var(--brand-text-tertiary)]"
      >
        {{ t('skills.location.autoHint') }}
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
