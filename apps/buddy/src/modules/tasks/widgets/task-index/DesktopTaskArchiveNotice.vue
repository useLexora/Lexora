<script setup lang="ts">
import type { LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { TaskArchiveActions } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton } from 'naive-ui'
import { onScopeDispose, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

const props = defineProps<{ task: LocalConversation, actions: TaskArchiveActions, language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const busy = shallowRef(false)
const error = shallowRef<string | null>(null)
let generation = 0
watch(() => props.task.id, () => {
  generation += 1
  busy.value = false
  error.value = null
}, { flush: 'sync' })
onScopeDispose(() => generation++)
async function restore() {
  if (busy.value || !props.actions.ready.value)
    return
  const task = props.task
  const token = generation
  busy.value = true
  error.value = null
  try {
    if (!await props.actions.restore(task.id, task.metadataRevision) && token === generation)
      error.value = t('desktop.archive.notCompleted')
  }
  catch (cause) {
    if (token === generation)
      error.value = resolveLocalChatErrorMessage(cause, props.language)
  }
  finally {
    if (token === generation)
      busy.value = false
  }
}
</script>

<template>
  <NAlert :show-icon="false" type="info">
    {{ t('desktop.archive.readOnly') }}
    <NButton text :disabled="!actions.ready.value" :loading="busy" @click="restore">
      {{ t('desktop.archive.restore') }}
    </NButton>
    <p v-if="error" role="alert" class="m-0">
      {{ error }}
    </p>
  </NAlert>
</template>
