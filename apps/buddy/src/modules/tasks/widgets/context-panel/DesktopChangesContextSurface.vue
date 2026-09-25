<script setup lang="ts">
import type { TaskChangesContextTab } from '../../model/context-panel/taskContextPanel'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { TaskChatWorkspace } from '@/modules/tasks/contracts'
import { NSpin } from 'naive-ui'
import { computed, nextTick, toRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopContextFileTree from '@/shared/ui/files/DesktopContextFileTree.vue'
import DesktopContextSplit from '@/shared/ui/files/DesktopContextSplit.vue'
import WorkbenchPanelContent from '@/workbench/browser/WorkbenchPanelContent.vue'
import DesktopChangeList from './DesktopChangeList.vue'
import DesktopChangeToolbar from './DesktopChangeToolbar.vue'
import { useContextChanges } from './useContextChanges'

const props = defineProps<{
  tab: TaskChangesContextTab | null
  context: Pick<TaskChatWorkspace['context'], 'getChangeOverview' | 'getChangeSet'>
  hasTab: (id: string) => boolean
  language: BuddyLocale
}>()
const { t } = useBuddyI18n(() => props.language)
const changeTab = toRef(() => props.tab)
const changes = useContextChanges({
  hasTab: id => props.hasTab(id),
  tab: changeTab,
  getOverview: input => props.context.getChangeOverview(input),
  getChangeSet: id => props.context.getChangeSet(id),
})
const changeView = changes.current
const allCollapsed = computed(() => {
  const view = changeView.value
  return Boolean(view?.detail?.files.length && view.detail.files.every(file => view.collapsedFiles.has(file.id)))
})
const changeList = useTemplateRef<InstanceType<typeof DesktopChangeList>>('changeList')
async function selectChangeFile(id: string) {
  const view = changeView.value
  if (!view)
    return
  view.selectedFileId = id
  view.collapsedFiles = new Set([...view.collapsedFiles].filter(value => value !== id))
  await nextTick()
  changeList.value?.reveal(id)
}
</script>

<template>
  <WorkbenchPanelContent v-if="changeTab && changeView">
    <template #toolbar>
      <DesktopChangeToolbar v-model:range="changeView.range" :language="language" :added="changes.counts.value.added" :deleted="changes.counts.value.deleted" :can-show-turn="Boolean(changeTab.changeSet)" :all-collapsed="allCollapsed" :wrap="changeView.wrap" :side-by-side="changeView.sideBySide" :tree-visible="changeView.treeVisible" @toggle-all="changes.toggleAll" @toggle-wrap="changeView.wrap = !changeView.wrap" @toggle-layout="changeView.sideBySide = !changeView.sideBySide" @toggle-tree="changeView.treeVisible = !changeView.treeVisible" />
    </template>
    <DesktopContextSplit v-model:width="changeView.treeWidth" :tree-visible="changeView.treeVisible">
      <div v-if="changeView.loading" class="context-resource-state">
        <NSpin size="small" />
      </div>
      <div v-else-if="changeView.failed" class="context-resource-state">
        {{ t('desktop.context.changesLoadFailed') }}
      </div>
      <div v-else-if="!changeView.detail?.files.length" class="context-resource-state">
        {{ t('desktop.context.noCapturedChanges') }}
      </div>
      <DesktopChangeList v-else ref="changeList" :files="changeView.detail.files" :language="language" :collapsed-files="changeView.collapsedFiles" :wrap="changeView.wrap" :side-by-side="changeView.sideBySide" @toggle="changes.toggleFile" />
      <template #tree>
        <DesktopContextFileTree v-model:expanded-keys="changeView.expandedKeys" :nodes="changes.nodes.value" :selected-key="changeView.selectedFileId" :language="language" @select="selectChangeFile" />
      </template>
    </DesktopContextSplit>
  </WorkbenchPanelContent>
</template>

<style scoped>
.context-resource-state { display: grid; flex: 1; min-width: 0; min-height: 0; place-content: center; padding: 20px; font-size: 12px; color: var(--buddy-text-muted); }
</style>
