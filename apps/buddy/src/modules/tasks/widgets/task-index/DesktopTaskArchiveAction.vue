<script setup lang="ts">
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { TaskArchiveActions } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton, NModal } from 'naive-ui'
import { computed, nextTick, onScopeDispose, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

const props = defineProps<{ actions: TaskArchiveActions, language: BuddyLocale }>()
const target = defineModel<LocalConversationSummary | null>('target', { required: true })
const { t } = useBuddyI18n(() => props.language)
const busy = shallowRef(false)
const error = shallowRef<string | null>(null)
const undoTarget = shallowRef<{ id: string, revision: number | null } | null>(null)
const running = computed(() => target.value && target.value.activity !== 'idle')
let generation = 0
let disposed = false
watch(target, () => {
  generation += 1
  error.value = null
}, { flush: 'sync' })
onScopeDispose(() => {
  disposed = true
  generation += 1
})
async function archive() {
  const task = target.value
  if (!task || busy.value || !props.actions.ready.value)
    return
  const token = generation
  busy.value = true
  error.value = null
  try {
    if (!await props.actions.archive(task.id, task.metadataRevision)) {
      if (token === generation)
        error.value = t('desktop.archive.notCompleted')
      return
    }
    if (token !== generation)
      return
    const receipt = task.activity === 'idle' ? { id: task.id, revision: null } : null
    undoTarget.value = receipt
    target.value = null
    await nextTick()
    if (disposed || target.value !== null || undoTarget.value !== receipt)
      return
    const undoGeneration = generation
    if (receipt) {
      try {
        const archived = await props.actions.get(task.id)
        if (undoTarget.value !== receipt || generation !== undoGeneration)
          return
        if (archived?.archivedAt && archived.metadataRevision !== undefined)
          undoTarget.value = { id: task.id, revision: archived.metadataRevision }
        else
          error.value = t('desktop.archive.undoUnavailable')
      }
      catch {
        if (undoTarget.value === receipt && generation === undoGeneration)
          error.value = t('desktop.archive.undoUnavailable')
      }
    }
  }
  catch (cause) {
    if (token === generation)
      error.value = resolveLocalChatErrorMessage(cause, props.language)
  }
  finally {
    busy.value = false
  }
}
async function undo() {
  const snapshot = undoTarget.value
  if (!snapshot || snapshot.revision === null || busy.value || !props.actions.ready.value)
    return
  busy.value = true
  const token = generation
  try {
    if (!await props.actions.restore(snapshot.id, snapshot.revision)) {
      if (token === generation)
        error.value = t('desktop.archive.notCompleted')
      return
    }
    if (token === generation && undoTarget.value === snapshot)
      undoTarget.value = null
  }
  catch (cause) {
    if (token === generation)
      error.value = resolveLocalChatErrorMessage(cause, props.language)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <NAlert v-if="undoTarget" :show-icon="false" type="info" closable @close="undoTarget = null">
    {{ t('desktop.archive.archived') }}
    <NButton text :disabled="busy || !actions.ready.value || undoTarget.revision === null" @click="undo">
      {{ t('desktop.archive.undo') }}
    </NButton>
    <span v-if="error" role="alert">{{ error }}</span>
  </NAlert>
  <NModal :show="target !== null" data-testid="task-archive-confirm" preset="dialog" :title="t(running ? 'desktop.archive.stopAndArchive' : 'desktop.archive.archive')" :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy" @update:show="!$event && !busy && (target = null)">
    <p>{{ target?.title || t('desktop.tasks.untitled') }}</p>
    <p>{{ t(running ? 'desktop.archive.runningConfirm' : 'desktop.archive.confirm') }}</p>
    <NAlert v-if="error" type="error" :show-icon="false">
      {{ error }}
    </NAlert>
    <template #action>
      <NButton :disabled="busy" @click="target = null">
        {{ t('common.cancel') }}
      </NButton>
      <NButton type="primary" :loading="busy" :disabled="!actions.ready.value" @click="archive">
        {{ t(running ? 'desktop.archive.stopAndArchive' : 'desktop.archive.archive') }}
      </NButton>
    </template>
  </NModal>
</template>
