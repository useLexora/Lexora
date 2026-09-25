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
      <div v-else class="context-resource-state">
        {{ t('desktop.context.selectFile') }}
      </div>
      <template #tree>
        <div v-if="fileView.treeFailed" class="context-tree-error">
          <span>{{ t('desktop.context.directoryLoadFailed') }}</span>
          <button type="button" class="context-tree-retry" @click="filePreview.refresh()">
            {{ t('desktop.context.retry') }}
          </button>
        </div>
        <DesktopContextFileTree v-model:expanded-keys="fileView.expandedKeys" :nodes="fileView.nodes" :selected-key="fileTab.target.path || null" :language="language" :load="filePreview.load" @select="emit('select', fileTab.id, $event)" />
      </template>
    </DesktopContextSplit>
  </WorkbenchPanelContent>
</template>

<style scoped>
.context-resource-state { display: grid; flex: 1; min-width: 0; min-height: 0; place-content: center; padding: 20px; font-size: 12px; color: var(--buddy-text-muted); }
.context-tree-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; font-size: 11px; color: var(--buddy-text-muted); }
.context-tree-retry { border: 0; background: transparent; padding: 0; color: var(--buddy-accent-solid); cursor: pointer; text-decoration: underline; font: inherit; font-size: 11px; }
.context-tree-retry:hover { opacity: 0.85; }
</style>
