<script setup lang="ts">
import type {
  DocsChatRenameDialogEmits,
  DocsChatRenameDialogProps,
} from './typing'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<DocsChatRenameDialogProps>()
const emits = defineEmits<DocsChatRenameDialogEmits>()
const { t } = useI18n()

const draft = shallowRef('')
const canSubmit = computed(() => Boolean(draft.value.trim()) && !props.loading)

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      draft.value = props.title
    }
  },
)

function submit() {
  if (!canSubmit.value) {
    return
  }

  emits('confirm', draft.value)
}
</script>

<template>
  <ElDialog
    :model-value="props.modelValue"
    :title="t('docs.chat.renameTitle')"
    width="360px"
    destroy-on-close
    @update:model-value="emits('update:modelValue', $event)"
    @keyup.enter="submit"
  >
    <ElInput
      v-model="draft"
      maxlength="120"
      show-word-limit
      :placeholder="t('docs.chat.renamePlaceholder')"
      :disabled="props.loading"
      autofocus
    />

    <template #footer>
      <ElButton @click="emits('update:modelValue', false)">
        {{ t('docs.common.cancel') }}
      </ElButton>
      <ElButton
        type="primary"
        :loading="props.loading"
        :disabled="!canSubmit"
        @click="submit"
      >
        {{ t('docs.common.save') }}
      </ElButton>
    </template>
  </ElDialog>
</template>
