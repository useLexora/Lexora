<script setup lang="ts">
import type { InputInst } from 'naive-ui'
import { validFileName } from '@buddy-shared/files/fileName'
import { NButton, NInput, NModal } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { explorerLabels } from './explorerLabels'

const props = defineProps<{ request: { title: string, name: string, parent: string } | null, language: string, platform: string | null }>()
const emit = defineEmits<{ finish: [name: string | null] }>()
const input = useTemplateRef<InputInst>('input')
const name = shallowRef('')
const labels = computed(() => explorerLabels(props.language))
const valid = computed(() => props.platform !== null && validFileName(name.value, props.platform))
watch(() => props.request, (request) => {
  name.value = request?.name ?? ''
  if (request) {
    void nextTick(() => {
      input.value?.focus()
      input.value?.select()
    })
  }
})
</script>

<template>
  <NModal :show="!!request" preset="card" :title="request?.title" class="explorer-name-dialog" style="width: min(420px, 90vw)" :mask-closable="false" @update:show="!$event && emit('finish', null)">
    <form class="flex flex-col gap-[12px]" @submit.prevent="valid && emit('finish', name)">
      <span v-if="request?.parent" class="text-[12px] text-muted truncate">{{ request.parent }}/</span>
      <NInput ref="input" v-model:value="name" :aria-label="labels.name" :placeholder="labels.name" :status="name && !valid ? 'error' : undefined" />
      <span v-if="name && !valid" role="alert" class="text-[12px]">{{ labels.invalidName }}</span>
      <div class="flex justify-end gap-[8px]">
        <NButton @click="emit('finish', null)">
          {{ labels.cancel }}
        </NButton>
        <NButton type="primary" attr-type="submit" :disabled="!valid">
          {{ labels.confirm }}
        </NButton>
      </div>
    </form>
  </NModal>
</template>
