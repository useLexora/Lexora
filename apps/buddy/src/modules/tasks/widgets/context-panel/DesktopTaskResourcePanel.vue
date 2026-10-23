<script setup lang="ts">
import type { DesktopBrowserApi } from '@buddy-electron/shared/desktopApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { TaskChatWorkspace } from '@/modules/tasks/contracts'
import type { ContextPanelTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import type { TaskResourcePanel } from '@/modules/tasks/state/context-panel/useTaskResourcePanel'
import { useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useTaskEnvironment } from '@/modules/tasks/taskContext'
import { useWorkbenchLaunchers } from '@/workbench/browser/useWorkbenchLaunchers'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
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
const { controller } = useWorkbench()
const message = useMessage()
const { actions, launch } = useWorkbenchLaunchers(controller)
const { browser, browserGuests, clipboard } = useTaskEnvironment()
const browserApi: DesktopBrowserApi = { ...browser, ensureSession: (conversationId, key) => props.panel.ensureBrowserSession(conversationId, key) }
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
async function add(id: string) {
  try {
    await launch(id)
  }
  catch {
    message.error(t('desktop.context.controlFailed'))
  }
}
</script>

<template>
  <DesktopFileSpacePicker :show="panel.fileSpacePickerOpen.value" :spaces="panel.filePickerSpaces.value" :language="language" @update:show="panel.setFileSpacePickerOpen" @select="panel.openFiles" />
  <DesktopTaskContextPanel :active-tab-id="activeTab?.id ?? null" :tabs="tabs" :language="language" :actions="actions" @add="add" @close-tab="panel.closeTab" @select-tab="panel.selectTab">
    <template v-if="$slots['header-actions']" #header-actions>
      <slot name="header-actions" />
    </template>
    <DesktopFilesContextSurface :tab="activeTab?.kind === 'files' ? activeTab : null" :files="context.files" :has-tab="panel.hasTab" :language="language" @select="panel.selectFile">
      <template #file-toolbar="bindings">
        <slot name="file-toolbar" v-bind="bindings" />
      </template>
      <template #file="bindings">
        <slot name="file" v-bind="bindings" />
      </template>
    </DesktopFilesContextSurface>
    <DesktopChangesContextSurface :tab="activeTab?.kind === 'changes' ? activeTab : null" :context="context" :has-tab="panel.hasTab" :language="language" />
    <DesktopBrowserContextSurface :tab="activeTab?.kind === 'browser' ? activeTab : null" :api="browserApi" :guest-host="browserGuests" :state="panel.activeBrowserState.value" :update-state="panel.updateBrowserState" :session-ready="panel.retainBrowserSession" :language="language" :visible="visible && activeTab?.kind === 'browser'" />
    <DesktopArtifactContextSurface v-if="activeTab?.kind === 'artifact'" :key="activeTab.id" :artifact="activeTab.artifact" :provider-id="activeTab.providerId" :tab-id="activeTab.id" :visible="visible" :language="language" :view-mode="activeTab.viewMode" :read-artifact-text="context.readArtifactText" :write-clipboard-text="clipboard.writeText" @update:view-mode="panel.setArtifactViewMode(activeTab.id, $event)" />
    <slot v-if="activeTab?.kind === 'view'" name="view" :view-id="activeTab.viewId" />
  </DesktopTaskContextPanel>
</template>
