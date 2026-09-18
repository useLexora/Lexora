<script setup lang="ts">
import { NButton, NResult, useMessage } from 'naive-ui'
import { useRouter } from 'vue-router'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useAutomationContext } from '@/modules/automations/automationContext'
import DesktopAutomationHistoryList from '@/modules/automations/widgets/list/DesktopAutomationHistoryList.vue'
import DesktopRuntimePane from '@/platform/runtime/DesktopRuntimePane.vue'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'

const router = useRouter()
const { language } = useDesktopUi()
const {
  automations,
  openTask: openTaskSession,
  onTaskDeleted,
  beforeTaskDelete,
  refreshTasks,
} = useAutomationContext()
const { t } = useBuddyI18n(language)
const message = useMessage()

async function openTask(conversationId: string): Promise<void> {
  await router.push(desktopRouteLocations.tasks())
  await openTaskSession(conversationId)
}

async function deleteOccurrence(occurrenceId: string): Promise<void> {
  const conversationId = automations.occurrences.value.items.find(item => item.id === occurrenceId)?.conversationId
  if (conversationId && !await beforeTaskDelete(conversationId))
    return
  const result = await automations.removeOccurrence(occurrenceId)
  if (result.status === 'failed') {
    message.error(result.error)
    return
  }
  if (result.status === 'succeeded' && result.value) {
    if (conversationId)
      onTaskDeleted(conversationId)
    await refreshTasks()
  }
}

async function loadMore(): Promise<void> {
  if (!await automations.loadMoreOccurrences() && automations.loadError.value)
    message.error(automations.loadError.value)
}

async function retry(): Promise<void> {
  if (!await automations.refresh() && automations.loadError.value)
    message.error(automations.loadError.value)
}
const { occurrences, isLoading, isLoadingMoreOccurrences, isMutating, loadError } = automations
</script>

<template>
  <DesktopRuntimePane
    class="desktop-automation-route-view"
    :loading="isLoading && occurrences.items.length === 0"
  >
    <NResult
      v-if="loadError && occurrences.items.length === 0"
      status="error"
      :description="loadError"
      :title="t('desktop.automations.loadFailed')"
    >
      <template #footer>
        <NButton secondary @click="retry">
          {{ t('desktop.automations.refresh') }}
        </NButton>
      </template>
    </NResult>
    <DesktopAutomationHistoryList
      v-else
      :busy="isMutating"
      :language="language"
      :occurrences="occurrences.items"
      @delete="deleteOccurrence($event.id)"
      @open-task="openTask"
    />
    <NButton
      v-if="occurrences.nextCursor"
      class="desktop-automation-route-view__more"
      secondary
      :loading="isLoadingMoreOccurrences"
      @click="loadMore"
    >
      {{ t('desktop.automations.loadMore') }}
    </NButton>
  </DesktopRuntimePane>
</template>

<style scoped>
.desktop-automation-route-view {
  display: flex;
  min-height: 280px;
  flex: 1;
  flex-direction: column;
}

.desktop-automation-route-view :deep(.n-spin-container),
.desktop-automation-route-view :deep(.n-spin-content) {
  display: flex;
  min-height: 280px;
  flex: 1;
  flex-direction: column;
}

.desktop-automation-route-view__more {
  align-self: center;
  margin-top: 18px;
}
</style>
