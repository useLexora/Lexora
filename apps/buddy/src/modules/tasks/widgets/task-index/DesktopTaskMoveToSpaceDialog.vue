<script setup lang="ts">
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton, NForm, NFormItem, NModal, NSelect, useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, useId, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

const props = defineProps<{
  busy: boolean
  language: BuddyLocale
  moveTaskToSpace: (taskId: string, spaceId: string, expectedRevision?: number) => Promise<boolean>
  show: boolean
  spaces: readonly { id: string, name: string }[]
  task: LocalConversationSummary | null
}>()
const emit = defineEmits<{
  'update:show': [show: boolean]
  'moved': [spaceId: string]
}>()
const { t } = useBuddyI18n(() => props.language)
const notification = useMessage()
const targetLabelId = useId()
const selectedSpaceId = shallowRef<string | null>(null)
const saving = shallowRef(false)
const spaceOptions = computed(() => props.spaces.map(space => ({ label: space.name, value: space.id })))
const selectedSpace = computed(() => props.spaces.find(space => space.id === selectedSpaceId.value))
const taskUnavailable = computed(() => !props.task || props.task.spaceId !== null)
const taskBusy = computed(() => props.busy || (props.task && props.task.activity !== 'idle'))
const canMove = computed(() => props.show && !taskUnavailable.value && !taskBusy.value && Boolean(selectedSpace.value) && !saving.value)
let session = 0
let expectedRevision: number | undefined
watch([() => props.show, () => props.task?.id], () => {
  session += 1
  expectedRevision = props.task?.metadataRevision
  selectedSpaceId.value = null
  saving.value = false
}, { flush: 'sync', immediate: true })
onScopeDispose(() => {
  session += 1
})

function updateShow(show: boolean) {
  if (!saving.value)
    emit('update:show', show)
}

async function confirmMove() {
  const task = props.task
  const space = selectedSpace.value
  if (!canMove.value || !task || !space)
    return
  const current = session
  saving.value = true
  try {
    const moved = await props.moveTaskToSpace(task.id, space.id, ...expectedRevision !== undefined ? [expectedRevision] as const : [])
    if (current !== session)
      return
    if (!moved) {
      notification.error(t('desktop.tasks.moveToSpaceFailed'))
      return
    }
    emit('moved', space.id)
    emit('update:show', false)
  }
  catch (error) {
    if (current === session)
      notification.error(resolveLocalChatErrorMessage(error, props.language))
  }
  finally {
    if (current === session)
      saving.value = false
  }
}
</script>

<template>
  <NModal
    class="desktop-task-move-dialog"
    preset="card"
    :show="show"
    :title="t('desktop.tasks.moveToSpace')"
    :style="{ width: 'min(28rem, calc(100vw - 2rem))', maxHeight: 'calc(100vh - 2rem)' }"
    :content-style="{ overflowY: 'auto' }"
    :closable="!saving"
    :close-on-esc="!saving"
    :mask-closable="!saving"
    @update:show="updateShow"
  >
    <p class="m-0 mb-4 text-fg [overflow-wrap:anywhere]">
      {{ t('desktop.tasks.moveToSpaceTask', { title: task?.title || t('desktop.tasks.untitled') }) }}
    </p>
    <NForm @submit.prevent="confirmMove">
      <NFormItem :label="t('desktop.tasks.moveToSpaceTarget')" :label-props="{ id: targetLabelId }">
        <NSelect
          v-model:value="selectedSpaceId"
          filterable
          clearable
          :disabled="saving || spaceOptions.length === 0"
          :options="spaceOptions"
          :input-props="{ 'aria-labelledby': targetLabelId }"
          :placeholder="t(spaceOptions.length ? 'desktop.tasks.spaceSearch' : 'desktop.tasks.moveToSpaceEmpty')"
        >
          <template #empty>
            {{ t('desktop.tasks.spaceSearchEmpty') }}
          </template>
        </NSelect>
      </NFormItem>
      <p class="m-0 text-muted text-[13px] leading-[1.6]">
        {{ t('desktop.tasks.moveToSpaceDescription') }}
      </p>
      <NAlert v-if="taskUnavailable || taskBusy" class="mt-4" :show-icon="false" type="warning">
        {{ taskUnavailable ? t('desktop.tasks.moveToSpaceUnavailable') : t('desktop.tasks.moveToSpaceBusy') }}
      </NAlert>
    </NForm>
    <template #footer>
      <div class="flex justify-end gap-2">
        <NButton :disabled="saving" @click="updateShow(false)">
          {{ t('common.cancel') }}
        </NButton>
        <NButton type="primary" :disabled="!canMove" :loading="saving" @click="confirmMove">
          {{ t('desktop.tasks.moveToSpaceConfirm') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>
