<script setup lang="ts">
import type { BrowserToolbarBusyAction, BrowserToolbarMenuActionKey } from './browserToolbarMenu'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { TaskChatWorkspace } from '@/modules/tasks/contracts'
import type { ContextPanelTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import type { TaskResourcePanel } from '@/modules/tasks/state/context-panel/useTaskResourcePanel'
import { Pause16Regular } from '@vicons/fluent'
import { NSpin, useMessage } from 'naive-ui'
import { computed, nextTick, shallowRef, toRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useTaskEnvironment } from '@/modules/tasks/taskContext'
import DesktopContextFileTree from '@/shared/ui/files/DesktopContextFileTree.vue'
import DesktopContextSplit from '@/shared/ui/files/DesktopContextSplit.vue'
import DesktopFileToolbar from '@/shared/ui/files/DesktopFileToolbar.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopArtifactContextSurface from './DesktopArtifactContextSurface.vue'
import DesktopBrowserToolbar from './DesktopBrowserToolbar.vue'
import DesktopChangeList from './DesktopChangeList.vue'
import DesktopChangeToolbar from './DesktopChangeToolbar.vue'
import DesktopFileSpacePicker from './DesktopFileSpacePicker.vue'
import DesktopTaskContextPanel from './DesktopTaskContextPanel.vue'
import { useBrowserAddress } from './useBrowserAddress'
import { useBrowserContextSurface } from './useBrowserContextSurface'
import { useContextChanges } from './useContextChanges'
import { useWorkspaceFilePreview } from './useWorkspaceFilePreview'

const props = defineProps<{
  panel: TaskResourcePanel
  context: TaskChatWorkspace['context']
  language: BuddyLocale
  visible: boolean
}>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const fileSpacePickerOpen = shallowRef(false)
const { browser, browserGuests, clipboard } = useTaskEnvironment()
const activeTab = computed(() => props.panel.activeTab.value)
const fileTab = computed(() => activeTab.value?.kind === 'files' ? activeTab.value : null)
const changeTab = computed(() => activeTab.value?.kind === 'changes' ? activeTab.value : null)
const browserTab = computed(() => activeTab.value?.kind === 'browser' ? activeTab.value : null)
const filePreview = useWorkspaceFilePreview(fileTab, props.context.files, id => props.panel.hasTab(id))
const fileView = filePreview.current
const changes = useContextChanges({
  hasTab: id => props.panel.hasTab(id),
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
const surfaceElement = useTemplateRef<HTMLElement>('surfaceElement')
const browserView = useBrowserContextSurface({
  api: browser,
  conversationId: computed(() => browserTab.value?.conversationId ?? null),
  tabId: computed(() => browserTab.value?.browserKey),
  enabled: computed(() => Boolean(browserTab.value)),
  visible: toRef(() => props.visible),
  state: toRef(() => props.panel.activeBrowserState.value),
  updateState: state => props.panel.updateBrowserState(state),
  sessionReady: (state, key) => props.panel.retainBrowserSession(state, key),
  guestHost: browserGuests,
  surfaceElement,
})
const { address, openAddress, updateAddress } = useBrowserAddress(browserView.state, browserView.navigate)
const browserState = browserView.state
const browserBlank = computed(() => browserState.value?.url === 'about:blank' && browserState.value.status !== 'loading')
const controlAnnouncement = shallowRef('')
watch(() => browserState.value?.controller, (controller, previous) => {
  if (controller === 'agent')
    controlAnnouncement.value = t('desktop.context.browserAgentControlling')
  else if (previous === 'agent')
    controlAnnouncement.value = t('desktop.context.browserAgentPaused')
})
const busyAction = computed<BrowserToolbarBusyAction | null>(() => browserView.isSwitchingProfile.value
  ? 'profile'
  : browserView.isCapturingScreenshot.value
    ? 'screenshot'
    : browserView.isOpeningExternal.value
      ? 'external'
      : browserView.isShowingFileInFolder.value ? 'folder' : browserView.isSettingZoom.value ? 'zoom' : null)
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
async function selectChangeFile(id: string) {
  const view = changeView.value
  if (!view)
    return
  view.selectedFileId = id
  view.collapsedFiles = new Set([...view.collapsedFiles].filter(value => value !== id))
  await nextTick()
  changeList.value?.reveal(id)
}
async function captureScreenshot() {
  const result = await browserView.captureScreenshot()
  if (result === 'saved' || result === 'copied')
    message.success(t(result === 'saved' ? 'desktop.browser.screenshotSaved' : 'desktop.browser.screenshotCopied'))
  else if (result === 'failed')
    message.error(t('desktop.browser.screenshotFailed'))
}
async function setZoom(factor: number | null) {
  if (!await browserView.setZoomFactor(factor))
    message.error(t('desktop.browser.zoomFailed'))
}
function browserMenu(action: BrowserToolbarMenuActionKey) {
  if (action === 'capture-screenshot')
    void captureScreenshot()
  else if (action === 'enter-incognito')
    void browserView.setProfileMode('incognito')
  else if (action === 'exit-incognito')
    void browserView.setProfileMode('default')
  else if (action === 'open-external')
    void browserView.openExternal()
  else if (action === 'show-file-in-folder')
    void browserView.showFileInFolder()
}
</script>

<template>
  <DesktopFileSpacePicker v-model:show="fileSpacePickerOpen" :spaces="panel.fileSpaces.value" :language="language" @select="panel.openFiles" />
  <DesktopTaskContextPanel :active-tab-id="activeTab?.id ?? null" :tabs="tabs" :language="language" :can-add-changes="panel.canAddChanges.value" :can-add-files="Boolean(panel.fileEntry.value)" @add="add" @close-tab="panel.closeTab" @select-tab="panel.selectTab">
    <template v-if="activeTab && activeTab.kind !== 'view' && activeTab.kind !== 'artifact'" #toolbar>
      <DesktopFileToolbar v-if="fileTab && fileView" :path="fileTab.target.path" :root-name="fileTab.rootName" :language="language" :wrap="fileView.wrap" :tree-visible="fileView.treeVisible" @toggle-wrap="fileView.wrap = !fileView.wrap" @toggle-tree="fileView.treeVisible = !fileView.treeVisible">
        <template v-if="fileTab.target.path" #default>
          <slot name="file-toolbar" :tab="fileTab" />
        </template>
      </DesktopFileToolbar>
      <DesktopChangeToolbar v-else-if="changeTab && changeView" v-model:range="changeView.range" :language="language" :added="changes.counts.value.added" :deleted="changes.counts.value.deleted" :can-show-turn="Boolean(changeTab.changeSet)" :all-collapsed="allCollapsed" :wrap="changeView.wrap" :side-by-side="changeView.sideBySide" :tree-visible="changeView.treeVisible" @toggle-all="changes.toggleAll" @toggle-wrap="changeView.wrap = !changeView.wrap" @toggle-layout="changeView.sideBySide = !changeView.sideBySide" @toggle-tree="changeView.treeVisible = !changeView.treeVisible" />
      <DesktopBrowserToolbar v-else-if="browserTab" :address="address" :busy-action="busyAction" :language="language" :state="browserState" @back="browserView.goBack" @forward="browserView.goForward" @navigate="openAddress" @reload="browserView.reload" @stop="browserView.stop" @update:address="updateAddress" @menu="browserMenu" @zoom="setZoom" />
    </template>
    <slot v-if="activeTab?.kind === 'view'" name="view" :view-id="activeTab.viewId" />
    <DesktopContextSplit v-else-if="fileTab && fileView" v-model:width="fileView.treeWidth" :tree-visible="fileView.treeVisible">
      <slot v-if="fileTab.target.path" name="file" :tab="fileTab" :wrap="fileView.wrap" :set-wrap="(value: boolean) => fileView!.wrap = value" />
      <div v-else class="context-resource-state">
        {{ t('desktop.context.selectFile') }}
      </div>
      <template #tree>
        <div v-if="fileView.treeFailed" class="context-tree-error">
          {{ t('desktop.context.directoryLoadFailed') }}
        </div>
        <DesktopContextFileTree v-model:expanded-keys="fileView.expandedKeys" :nodes="fileView.nodes" :selected-key="fileTab.target.path || null" :language="language" :load="filePreview.load" @select="panel.selectFile(fileTab.id, $event)" />
      </template>
    </DesktopContextSplit>
    <DesktopContextSplit v-else-if="changeView" v-model:width="changeView.treeWidth" :tree-visible="changeView.treeVisible">
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
    <div v-else-if="browserTab && browserView.failed.value" class="context-resource-state" role="alert">
      {{ t('desktop.context.browserLoadFailed') }}
    </div>
    <section v-else-if="browserTab" class="desktop-browser-context-surface" data-testid="browser-context-surface">
      <div
        v-if="browserState?.controller === 'agent'"
        class="desktop-browser-context-surface__control"
        data-testid="browser-agent-control"
      >
        <span class="desktop-browser-context-surface__control-state">
          <span class="desktop-browser-context-surface__control-indicator" aria-hidden="true" />
          {{ t('desktop.context.browserAgentControlling') }}
        </span>
        <button
          class="desktop-browser-context-surface__take-control"
          data-testid="browser-take-control"
          type="button"
          :aria-label="t(browserView.isTakingControl.value
            ? 'desktop.context.browserTakingControl'
            : 'desktop.context.browserTakeControl')"
          :aria-busy="browserView.isTakingControl.value"
          :disabled="browserView.isTakingControl.value"
          @click="browserView.takeControl"
        >
          <DesktopIcon aria-hidden="true" :component="Pause16Regular" />
          <span>
            {{ t(browserView.isTakingControl.value
              ? 'desktop.context.browserTakingControl'
              : 'desktop.context.browserTakeControl') }}
          </span>
        </button>
      </div>
      <span
        class="desktop-browser-context-surface__announcement"
        data-testid="browser-control-announcement"
        aria-atomic="true"
        aria-live="polite"
        role="status"
      >
        {{ controlAnnouncement }}
      </span>
      <div
        ref="surfaceElement"
        class="desktop-browser-context-surface__viewport"
        data-testid="browser-guest-surface"
        role="group"
        :aria-label="t('desktop.context.browserViewport')"
      >
        <div v-if="browserBlank" class="desktop-browser-context-surface__empty">
          <p>{{ t('desktop.context.browserStartBrowsing') }}</p>
        </div>
      </div>
    </section>
    <DesktopArtifactContextSurface v-else-if="activeTab?.kind === 'artifact'" :key="activeTab.id" :artifact="activeTab.artifact" :language="language" :view-mode="activeTab.viewMode" :read-artifact-text="context.readArtifactText" :write-clipboard-text="clipboard.writeText" @update:view-mode="panel.setArtifactViewMode(activeTab.id, $event)" />
  </DesktopTaskContextPanel>
</template>

<style scoped>
.context-resource-state { display: grid; flex: 1; min-width: 0; min-height: 0; place-content: center; padding: 20px; font-size: 12px; color: var(--buddy-text-muted); }
.context-tree-error { padding: 8px 12px; font-size: 11px; color: var(--buddy-text-muted); }
.desktop-browser-context-surface {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  background: var(--buddy-surface-base);
}

.desktop-browser-context-surface__control {
  position: relative;
  z-index: 2;
  display: flex;
  min-width: 0;
  min-height: 2.375rem;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border-bottom: 1px solid var(--buddy-accent-border);
  background: var(--buddy-accent-surface-subtle);
  color: var(--buddy-accent-on-surface);
  padding: 0.25rem 0.5rem 0.25rem 0.75rem;
}

.desktop-browser-context-surface__control-state {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
}

.desktop-browser-context-surface__control-indicator {
  width: 0.5rem;
  height: 0.5rem;
  flex: none;
  border-radius: 50%;
  background: var(--buddy-accent-solid);
}

.desktop-browser-context-surface__take-control {
  display: flex;
  min-height: 1.875rem;
  flex: none;
  align-items: center;
  gap: 0.375rem;
  border: 0;
  border-radius: 0.375rem;
  background: var(--buddy-accent-solid);
  color: var(--buddy-text-on-accent);
  cursor: pointer;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
}

.desktop-browser-context-surface__take-control:not(:disabled):hover {
  background: var(--buddy-accent-solid-hover);
}

.desktop-browser-context-surface__take-control:not(:disabled):active {
  background: var(--buddy-accent-solid-pressed);
}

.desktop-browser-context-surface__take-control:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 2px;
}

.desktop-browser-context-surface__take-control:disabled {
  cursor: wait;
  opacity: 0.72;
}

.desktop-browser-context-surface__announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.desktop-browser-context-surface__viewport {
  position: relative;
  min-width: 0;
  min-height: 0;
  flex: 1;
  background: var(--buddy-surface-base);
}

.desktop-browser-context-surface__empty {
  position: absolute;
  z-index: 2;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--buddy-surface-base);
  color: var(--buddy-text-muted);
  padding: 24px;
  pointer-events: none;
  font-size: 13px;
  text-align: center;
}

.desktop-browser-context-surface__empty p {
  margin: 0;
}
</style>
