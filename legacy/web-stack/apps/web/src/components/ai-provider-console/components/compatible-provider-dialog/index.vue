<script setup lang="ts">
import type { FormInstance } from 'element-plus'
import type { AiProviderFormController } from '../../typing'
import type {
  AiCompatibleProviderDialogEmits,
  AiCompatibleProviderDialogProps,
} from './typing'
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<AiCompatibleProviderDialogProps>()
const emit = defineEmits<AiCompatibleProviderDialogEmits>()
const visible = defineModel<boolean>('visible', { required: true })

const formRef = useTemplateRef<FormInstance>('formRef')
const { t } = useI18n({ useScope: 'global' })

const dialogTitle = computed(() => props.mode === 'create' ? t('aiProvider.compatibleProvider.createTitle') : t('aiProvider.compatibleProvider.editTitle'))
const confirmText = computed(() => props.mode === 'create' ? t('aiProvider.common.add') : t('aiProvider.common.save'))

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
  <ElDialog v-model="visible" :title="dialogTitle" width="28rem">
    <ElForm ref="formRef" :model="form" :rules="rules" label-position="top">
      <ElFormItem :label="t('aiProvider.compatibleProvider.type')" prop="providerKey">
        <ElSelect v-model="form.providerKey" class="w-full">
          <ElOption
            v-for="template in presets"
            :key="template.providerKey"
            :label="template.providerName"
            :value="template.providerKey"
          />
        </ElSelect>
      </ElFormItem>
      <ElFormItem :label="t('aiProvider.compatibleProvider.name')" prop="providerName">
        <ElInput v-model="form.providerName" :placeholder="mode === 'create' ? t('aiProvider.compatibleProvider.namePlaceholder') : undefined" />
      </ElFormItem>
    </ElForm>

    <template #footer>
      <ElButton @click="visible = false">
        {{ t('aiProvider.common.cancel') }}
      </ElButton>
      <ElButton type="primary" :loading="loading" @click="emit('submit')">
        {{ confirmText }}
      </ElButton>
    </template>
  </ElDialog>
</template>
