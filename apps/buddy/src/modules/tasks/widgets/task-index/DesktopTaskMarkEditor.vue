<script setup lang="ts">
import type { LocalTaskMark, TaskMarkInput } from '@buddy-shared/conversation/taskMarkApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { TASK_MARK_COLORS, TASK_MARK_DESCRIPTION_LIMIT, TASK_MARK_NAME_LIMIT, taskMarkInputSchema, taskMarkTextLength } from '@buddy-shared/conversation/taskMarkApi'
import { NButton, NForm, NFormItem, NInput } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopTaskMarkColorPicker from './DesktopTaskMarkColorPicker.vue'

const props = defineProps<{
  initial: Pick<LocalTaskMark, 'id' | 'name' | 'description' | 'color'> | null
  readonly?: boolean
  busy: boolean
  language: BuddyLocale
}>()
const emit = defineEmits<{ save: [input: TaskMarkInput] }>()
const { t } = useBuddyI18n(() => props.language)
const name = shallowRef(props.initial?.name ?? '')
const description = shallowRef(props.initial?.description ?? '')
const color = shallowRef(props.initial?.color ?? TASK_MARK_COLORS[0])
const parsed = computed(() => taskMarkInputSchema.safeParse({ name: name.value, description: description.value, color: color.value }))
function submit() {
  if (!props.readonly && !props.busy && parsed.value.success)
    emit('save', parsed.value.data)
}
</script>

<template>
  <NForm class="desktop-task-mark-editor" label-placement="top" :disabled="busy" @submit.prevent="submit">
    <NFormItem :label="t('desktop.marks.name')" :required="!readonly">
      <NInput v-model:value="name" :autofocus="!readonly" :readonly="readonly" :maxlength="readonly ? undefined : TASK_MARK_NAME_LIMIT" :count-graphemes="taskMarkTextLength" :show-count="!readonly" />
    </NFormItem>
    <NFormItem :label="t('desktop.marks.description')">
      <NInput v-model:value="description" type="textarea" :readonly="readonly" :autosize="{ minRows: 3, maxRows: 5 }" :maxlength="readonly ? undefined : TASK_MARK_DESCRIPTION_LIMIT" :count-graphemes="taskMarkTextLength" :show-count="!readonly" />
    </NFormItem>
    <NFormItem :label="t('desktop.marks.color')" :required="!readonly">
      <DesktopTaskMarkColorPicker v-model="color" :disabled="busy" :readonly="readonly" :language="language" />
    </NFormItem>
    <div v-if="!readonly" class="flex justify-end gap-[8px]">
      <NButton type="primary" attr-type="submit" :loading="busy" :disabled="!parsed.success || busy">
        {{ t('common.save') }}
      </NButton>
    </div>
  </NForm>
</template>
