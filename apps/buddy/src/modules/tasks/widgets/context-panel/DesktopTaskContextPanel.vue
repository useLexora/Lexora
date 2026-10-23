<script setup lang="ts">
import type { ContextPanelTab } from '../../model/context-panel/taskContextPanel'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { WorkbenchLauncherAction } from '@/workbench/browser/useWorkbenchLaunchers'
import { Code16Regular, Globe16Regular } from '@vicons/fluent'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import WorkbenchResourcePanel from '@/workbench/browser/WorkbenchResourcePanel.vue'

defineProps<{
  activeTabId: string | null
  actions: readonly WorkbenchLauncherAction[]
  language: BuddyLocale
  tabs: readonly ContextPanelTab[]
}>()
const emit = defineEmits<{
  add: [id: string]
  closeTab: [tabId: string]
  selectTab: [tabId: string]
}>()
defineSlots<{ 'default'?: () => unknown, 'header-actions'?: () => unknown, 'toolbar'?: () => unknown }>()
</script>

<template>
  <WorkbenchResourcePanel :active-tab-id="activeTabId" :tabs="tabs" :language="language" :actions="actions" @add="emit('add', $event)" @close-tab="emit('closeTab', $event)" @select-tab="emit('selectTab', $event)">
    <template #icon="{ tab }">
      <FileIcon v-if="tab.icon === 'file'" :name="tab.fileName ?? tab.title" />
      <FolderIcon v-else-if="tab.icon === 'folder'" class="desktop-task-context-panel__folder-icon w-4 h-4 flex-none" />
      <DesktopIcon v-else :component="tab.icon === 'browser' ? Globe16Regular : Code16Regular" />
    </template>
    <template v-if="$slots.toolbar" #toolbar>
      <slot name="toolbar" />
    </template>
    <template v-if="$slots['header-actions']" #header-actions>
      <slot name="header-actions" />
    </template>
    <slot />
  </WorkbenchResourcePanel>
</template>
