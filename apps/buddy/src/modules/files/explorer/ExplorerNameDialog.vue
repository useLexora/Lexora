<script setup lang="ts">
import type { InputInst } from 'naive-ui'
import type { ExplorerNameError, ExplorerNameRequest } from './useExplorerCommands'
import { validFileName } from '@buddy-shared/files/fileName'
import { NButton, NForm, NFormItem, NInput, NModal } from 'naive-ui'
import { computed, nextTick, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { explorerLabels } from './explorerLabels'

const props = defineProps<{ request: ExplorerNameRequest | null, error: ExplorerNameError | null, busy: boolean, language: string, platform: string | null }>()
const emit = defineEmits<{ finish: [name: string | null], edit: [] }>()
const input = useTemplateRef<InputInst>('input')
const name = shallowRef('')
const inputId = useId()
const errorId = `${inputId}-error`
const labels = computed(() => explorerLabels(props.language))
const valid = computed(() => props.platform !== null && validFileName(name.value, props.platform))
const validationMessage = computed(() => name.value && !valid.value ? labels.value.invalidName : props.error?.message ?? '')
const validationStatus = computed(() => name.value && !valid.value ? 'error' : props.error?.status)
const isNewFile = computed(() => props.request?.kind === 'newFile')
const nameLabel = computed(() => isNewFile.value ? labels.value.fileName : labels.value.name)
watch(() => props.request, (request) => {
  name.value = request?.name ?? ''
  if (request) {
    void nextTick(() => {
      input.value?.focus()
      if (request.kind === 'newFile')
        input.value?.inputElRef?.setSelectionRange(0, request.name.lastIndexOf('.'))
      else
        input.value?.select()
    })
  }
})
</script>

<template>
  <NModal :show="!!request" preset="card" :title="request?.title" class="explorer-name-dialog" style="width: min(420px, 90vw)" :mask-closable="false" :closable="!busy" :close-on-esc="!busy" @update:show="!$event && emit('finish', null)">
    <NForm :disabled="busy" :show-require-mark="false" @submit.prevent="valid && !busy && emit('finish', name)">
      <span v-if="request?.parent" class="block mb-[12px] text-[12px] text-muted truncate">{{ request.parent }}/</span>
      <NFormItem :label="nameLabel" :label-props="{ for: inputId }" :validation-status="validationStatus">
        <NInput ref="input" v-model:value="name" :input-props="{ 'id': inputId, 'aria-describedby': validationMessage ? errorId : undefined, 'aria-invalid': !!validationMessage }" :placeholder="nameLabel" @update:value="emit('edit')" />
        <template #feedback>
          <span v-if="validationMessage" :id="errorId" role="alert">{{ validationMessage }}</span>
        </template>
      </NFormItem>
      <div class="flex justify-end gap-[8px]">
        <NButton :disabled="busy" @click="emit('finish', null)">
          {{ labels.cancel }}
        </NButton>
        <NButton type="primary" attr-type="submit" :disabled="!valid || busy" :loading="busy">
          {{ labels.confirm }}
        </NButton>
      </div>
    </NForm>
  </NModal>
</template>
