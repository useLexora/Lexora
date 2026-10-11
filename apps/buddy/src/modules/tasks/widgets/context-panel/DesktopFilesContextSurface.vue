<script setup lang="ts">
import type { TaskFilesContextTab } from '../../model/context-panel/taskContextPanel'
import type { WorkspaceFilesApi } from './useWorkspaceFilePreview'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { toRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopContextFileTree from '@/shared/ui/files/DesktopContextFileTree.vue'
import DesktopContextSplit from '@/shared/ui/files/DesktopContextSplit.vue'
import DesktopFileToolbar from '@/shared/ui/files/DesktopFileToolbar.vue'
import WorkbenchPanelContent from '@/workbench/browser/WorkbenchPanelContent.vue'
import { useWorkspaceFilePreview } from './useWorkspaceFilePreview'

const props = defineProps<{
  tab: TaskFilesContextTab | null
  files: WorkspaceFilesApi
  hasTab: (id: string) => boolean
  language: BuddyLocale
}>()
const emit = defineEmits<{ select: [id: string, path: string] }>()
const { t } = useBuddyI18n(() => props.language)
const fileTab = toRef(() => props.tab)
const filePreview = useWorkspaceFilePreview(fileTab, props.files, id => props.hasTab(id))
const fileView = filePreview.current
</script>

<template>
  <WorkbenchPanelContent v-if="fileTab && fileView">
    <template #toolbar>
      <DesktopFileToolbar :path="fileTab.target.path" :root-name="fileTab.rootName" :language="language" :wrap="fileView.wrap" :tree-visible="fileView.treeVisible" @toggle-wrap="fileView.wrap = !fileView.wrap" @toggle-tree="fileView.treeVisible = !fileView.treeVisible" @refresh="filePreview.refresh()">
        <template v-if="fileTab.target.path" #default>
          <slot name="file-toolbar" :tab="fileTab" />
        </template>
      </DesktopFileToolbar>
    </template>
    <DesktopContextSplit v-model:width="fileView.treeWidth" :tree-visible="fileView.treeVisible">
      <slot v-if="fileTab.target.path" name="file" :tab="fileTab" :wrap="fileView.wrap" :set-wrap="(value: boolean) => fileView!.wrap = value" />
      <div v-else class="context-resource-state grid flex-1 min-w-0 min-h-0 p-[20px] text-[12px] text-muted">
        {{ t('desktop.context.selectFile') }}
      </div>
      <template #tree>
        <div v-if="fileView.treeFailed" class="context-tree-error flex items-center justify-between gap-[8px] py-[8px] px-[12px] text-[11px] text-muted">
          <span>{{ t('desktop.context.directoryLoadFailed') }}</span>
          <button type="button" class="context-tree-retry border-0 bg-transparent p-0 text-accent cursor-pointer underline text-[11px] hover:opacity-85" @click="filePreview.refresh()">
            {{ t('desktop.context.retry') }}
          </button>
        </div>
        <DesktopContextFileTree v-model:expanded-keys="fileView.expandedKeys" :nodes="fileView.nodes" :selected-key="fileTab.target.path || null" :language="language" :load="filePreview.load" @select="emit('select', fileTab.id, $event)" />
      </template>
    </DesktopContextSplit>
  </WorkbenchPanelContent>
</template>

<style scoped lang="scss">
.context-resource-state { place-content: center; }
</style>
