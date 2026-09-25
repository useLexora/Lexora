<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { TaskChatWorkspace } from '@/modules/tasks/contracts'
import type { ContextPanelTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import type { TaskResourcePanel } from '@/modules/tasks/state/context-panel/useTaskResourcePanel'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useTaskEnvironment } from '@/modules/tasks/taskContext'
import DesktopArtifactContextSurface from './DesktopArtifactContextSurface.vue'
import DesktopBrowserContextSurface from './DesktopBrowserContextSurface.vue'
import DesktopChangesContextSurface from './DesktopChangesContextSurface.vue'
import DesktopFilesContextSurface from './DesktopFilesContextSurface.vue'
import DesktopFileSpacePicker from './DesktopFileSpacePicker.vue'
import DesktopTaskContextPanel from './DesktopTaskContextPanel.vue'

const props = defineProps<{
  panel: TaskResourcePanel
  context: TaskChatWorkspace['context']
  language: BuddyLocale
  visible: boolean
}>()
const { t } = useBuddyI18n(() => props.language)
const fileSpacePickerOpen = shallowRef(false)
const { browser, browserGuests, clipboard } = useTaskEnvironment()
const activeTab = computed(() => props.panel.activeTab.value)
const tabs = computed<ContextPanelTab[]>(() => props.panel.tabs.value.map((tab) => {
  if (tab.kind === 'view')
    return { id: tab.id, title: tab.label, icon: 'file' }
  if (tab.kind === 'artifact')
    return { id: tab.id, title: tab.artifact.name, icon: tab.artifact.kind === 'directory' ? 'folder' : 'file', fileName: tab.artifact.name }
  if (tab.kind === 'files')
    return { id: tab.id, title: t('desktop.context.files'), icon: 'folder' }
  if (tab.kind === 'changes')
    return { id: tab.id, title: t('desktop.context.changes'), icon: 'changes' }
  const state = props.panel.browserStates.value[tab.id]
  const title = !state || state.url === 'about:blank'
    ? t('desktop.context.browserNewTab')
    : state.title.trim() || t('desktop.context.browser')
  return { id: tab.id, title, icon: 'browser' }
}))
function add(kind: 'changes' | 'files' | 'browser') {
  if (kind === 'files') {
    const entry = props.panel.fileEntry.value
    if (entry?.kind === 'space-picker')
      fileSpacePickerOpen.value = true
    else if (entry?.kind === 'directory')
      props.panel.openFiles(entry.spaceId)
  }
  else if (kind === 'changes') {
    props.panel.openChanges()
  }
  else {
    props.panel.addBrowser()
  }
}
</script>

<template>
  <DesktopFileSpacePicker v-model:show="fileSpacePickerOpen" :spaces="panel.fileSpaces.value" :language="language" @select="panel.openFiles" />
  <DesktopTaskContextPanel :active-tab-id="activeTab?.id ?? null" :tabs="tabs" :language="language" :can-add-changes="panel.canAddChanges.value" :can-add-files="Boolean(panel.fileEntry.value)" @add="add" @close-tab="panel.closeTab" @select-tab="panel.selectTab">
    <DesktopFilesContextSurface :tab="activeTab?.kind === 'files' ? activeTab : null" :files="context.files" :has-tab="panel.hasTab" :language="language" @select="panel.selectFile">
      <template #file-toolbar="bindings">
        <slot name="file-toolbar" v-bind="bindings" />
      </template>
      <template #file="bindings">
        <slot name="file" v-bind="bindings" />
      </template>
    </DesktopFilesContextSurface>
    <DesktopChangesContextSurface :tab="activeTab?.kind === 'changes' ? activeTab : null" :context="context" :has-tab="panel.hasTab" :language="language" />
    <DesktopBrowserContextSurface :tab="activeTab?.kind === 'browser' ? activeTab : null" :api="browser" :guest-host="browserGuests" :state="panel.activeBrowserState.value" :update-state="panel.updateBrowserState" :session-ready="panel.retainBrowserSession" :language="language" :visible="visible && activeTab?.kind === 'browser'" />
    <DesktopArtifactContextSurface v-if="activeTab?.kind === 'artifact'" :key="activeTab.id" :artifact="activeTab.artifact" :language="language" :view-mode="activeTab.viewMode" :read-artifact-text="context.readArtifactText" :write-clipboard-text="clipboard.writeText" @update:view-mode="panel.setArtifactViewMode(activeTab.id, $event)" />
    <slot v-if="activeTab?.kind === 'view'" name="view" :view-id="activeTab.viewId" />
  </DesktopTaskContextPanel>
</template>
