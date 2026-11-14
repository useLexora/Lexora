<script setup lang="ts">
import type { ConversationArchiveItem } from '@buddy-shared/conversation/conversationArchiveApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { TaskArchiveActions } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton, NModal, NSpin } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import DesktopTaskArchiveFilters from './DesktopTaskArchiveFilters.vue'
import DesktopTaskArchiveList from './DesktopTaskArchiveList.vue'
import DesktopTaskArchivePolicy from './DesktopTaskArchivePolicy.vue'
import { useTaskArchiveManager } from './useTaskArchiveManager'

const props = defineProps<{ actions: TaskArchiveActions, spaces: readonly LocalSpace[], language: BuddyLocale }>()
const emit = defineEmits<{ view: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const { query, spaceId, items, results, cursor, busy, loading, error, load, snapshotSpace, deleteBatch, restore } = useTaskArchiveManager({
  actions: () => props.actions,
  show: () => true,
  errorMessage: cause => resolveLocalChatErrorMessage(cause, props.language),
  notDeletedMessage: () => t('desktop.archive.notCompleted'),
})
const confirmation = shallowRef<{ items: readonly ConversationArchiveItem[], space?: { id: string | null, name: string } } | null>(null)
const spaceActionBusy = shallowRef<{ spaceId: string | null } | null>(null)
const notice = shallowRef<string | null>(null)
const detachedFailures = computed(() => results.value.filter(result => result.status === 'failed' && !items.value.some(item => item.id === result.item.id)))
const disabled = computed(() => busy.value || !props.actions.ready.value)
function requestDelete(targets: readonly ConversationArchiveItem[]) {
  notice.value = null
  confirmation.value = { items: targets.map(item => ({ ...item })) }
}
async function requestSpaceDelete(spaceId: string | null, name: string) {
  notice.value = null
  spaceActionBusy.value = { spaceId }
  try {
    const targets = await snapshotSpace(spaceId)
    if (targets?.length)
      confirmation.value = { items: targets, space: { id: spaceId, name } }
    else if (targets)
      notice.value = t('desktop.archive.emptySpace')
  }
  finally {
    spaceActionBusy.value = null
  }
}
async function confirmDelete() {
  const pendingConfirmation = confirmation.value
  const batch = pendingConfirmation?.items
  if (!batch || disabled.value)
    return
  confirmation.value = null
  spaceActionBusy.value = pendingConfirmation.space ? { spaceId: pendingConfirmation.space.id } : null
  try {
    await deleteBatch(batch)
  }
  finally {
    spaceActionBusy.value = null
  }
}
</script>

<template>
  <section data-testid="task-archive-manager" class="min-w-0 flex flex-col gap-5 [container-type:inline-size]" :aria-busy="loading || busy">
    <div class="relative flex flex-wrap items-start justify-between gap-x-6 gap-y-3" data-testid="task-archive-toolbar">
      <DesktopTaskArchiveFilters v-model:query="query" v-model:space-id="spaceId" class="w-full max-w-[28rem]" :spaces="spaces" :disabled="disabled" :language="language" />
      <DesktopTaskArchivePolicy class="ml-auto w-56 max-w-full" :actions="actions" :language="language" :disabled="busy" />
      <NSpin v-if="!spaceActionBusy && (loading || busy)" class="absolute right-0 top-full mt-1" :size="16" />
    </div>
    <NAlert v-if="!actions.ready.value" type="warning" :show-icon="false">
      {{ t('desktop.archive.unavailable') }}
    </NAlert>
    <NAlert v-if="error" type="error" :show-icon="false">
      {{ error }}
    </NAlert>
    <NAlert v-if="notice" type="info" :show-icon="false">
      {{ notice }}
    </NAlert>
    <div v-if="loading && !items.length" class="flex min-h-40 items-center justify-center text-sm text-muted" role="status">
      {{ t('desktop.archive.loading') }}
    </div>
    <DesktopTaskArchiveList v-else-if="items.length || (actions.ready.value && !error)" :items="items" :spaces="spaces" :results="results" :disabled="disabled" :space-action-busy="spaceActionBusy" :language="language" @view="emit('view', $event)" @restore="restore" @delete="requestDelete([$event])" @delete-space="requestSpaceDelete" />
    <div v-if="cursor" class="flex justify-center">
      <NButton quaternary :loading="loading" :disabled="disabled || loading" @click="load(true)">
        {{ t('desktop.archive.more') }}
      </NButton>
    </div>
    <NAlert v-for="result in detachedFailures" :key="result.item.id" type="error" :show-icon="false" data-delete-result="failed" aria-live="polite">
      {{ result.item.title || t('desktop.tasks.untitled') }} · {{ result.error }}
    </NAlert>
    <NModal :show="confirmation !== null" data-testid="task-archive-delete-confirm" preset="dialog" type="warning" :title="t('desktop.tasks.deleteTaskConfirmTitle')" @update:show="!$event && (confirmation = null)">
      <p v-if="confirmation?.space">
        {{ t('desktop.archive.deleteSpaceConfirm', { space: confirmation.space.name, count: confirmation.items.length }) }}
      </p>
      <p>{{ t('desktop.archive.deleteConfirm', { count: confirmation?.items.length ?? 0 }) }}</p>
      <ul class="max-h-40 overflow-auto">
        <li v-for="item in confirmation?.items" :key="item.id" class="break-words">
          {{ item.title || t('desktop.tasks.untitled') }}
        </li>
      </ul>
      <template #action>
        <NButton @click="confirmation = null">
          {{ t('common.cancel') }}
        </NButton>
        <NButton type="error" :disabled="disabled" @click="confirmDelete">
          {{ t('common.delete') }}
        </NButton>
      </template>
    </NModal>
  </section>
</template>
