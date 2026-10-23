import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { ContextPanelSource } from '@buddy-shared/context-panel/contextPanel'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { ArtifactViewMode, TaskContextTab } from '../../model/context-panel/taskContextPanel'
import type { UseTaskContextPanelOptions } from './typing'
import { getActiveSpaceDirectories } from '@buddy-shared/spaces/spaceApi'
import { computed, readonly, watch } from 'vue'
import { useContextPanelControl } from '@/platform/desktop/useContextPanelControl'
import { readContextSelection, readContextTab } from '../../model/context-panel/readContextTab'
import { artifactTabId, browserTabId, contextTabSource, spaceTaskBrowserTab, taskContextPanelScope } from '../../model/context-panel/taskContextPanel'
import { useContextPanelTabs } from './useContextPanelTabs'

export function useTaskContextPanel(options: UseTaskContextPanelOptions) {
  const store = useContextPanelTabs({ mode: options.mode, scopeSpaceIds: options.scopeSpaceIds, conversationId: options.activeConversationId, draftId: options.activeDraftId })
  const linked = computed(() => options.mode.value !== 'independent')
  const getSource = () => contextTabSource(store.activeTab.value)
    ?? (linked.value && options.taskVisible.value ? currentSource() ?? null : null)
  const control = useContextPanelControl({
    api: options.control,
    getSource,
    onError: options.onError,
    onTarget: (target) => {
      const tab = spaceTaskBrowserTab(target.source.conversationId)
      if (tab)
        store.put({ ...tab, source: target.source }, options.taskVisible.value && target.source.conversationId === options.activeConversationId.value)
    },
  })
  const fileSpaces = computed(() => options.spaces.value.filter(space => getActiveSpaceDirectories(space).length > 0))
  const currentFileSpace = computed(() => fileSpaces.value.find(space => space.id === options.activeSpace?.value?.id) ?? null)
  const fileEntry = computed(() => {
    if (!linked.value)
      return { kind: 'space-picker' as const }
    return options.taskVisible.value && currentFileSpace.value
      ? { kind: 'directory' as const, spaceId: currentFileSpace.value.id }
      : null
  })
  const canAddChanges = computed(() => linked.value && options.taskVisible.value
    && Boolean(options.activeConversationId.value)
    && !store.tabs.value.some(tab => tab.kind === 'changes' && tab.conversationId === options.activeConversationId.value))
  const changeRevision = computed(() => options.changeSets.value.filter(set => set.conversationId === options.activeConversationId.value)
    .map(set => `${set.changeSetId}:${set.updatedAt}`)
    .join('|'))

  watch(options.spaces, () => store.retain(isAvailable))
  watch([changeRevision, options.activeBranchId, options.activeConversationId, options.mode], ([revision, branchId]) => {
    store.update((tab) => {
      if (tab.kind !== 'changes' || tab.id !== `changes:${tab.conversationId}` || tab.conversationId !== options.activeConversationId.value)
        return tab
      if (tab.branchId !== branchId)
        return linked.value ? { ...tab, branchId, revision, changeSet: null, source: currentSource() } : tab
      return tab.revision !== revision ? { ...tab, revision } : tab
    })
  })

  function openTab(tab: TaskContextTab) {
    store.put(tab)
    void control.open()
  }

  function currentSource(): ContextPanelSource | undefined {
    const conversationId = options.activeConversationId.value
    const runId = options.activeRunId.value
    return conversationId && runId ? { conversationId, runId } : undefined
  }

  function openArtifact(target: string | LocalArtifact, providerId?: string) {
    const artifact = typeof target === 'string'
      ? options.runOutputs.value.flatMap(output => output.artifacts).find(item => item.artifactId === target)
      : target
    if (!artifact)
      return
    const id = artifactTabId(artifact.artifactId)
    const previous = store.resources.value.find(tab => tab.id === id)
    openTab({ artifact, id, scope: taskContextPanelScope(artifact.conversationId), kind: 'artifact', label: artifact.name, providerId, viewMode: previous?.kind === 'artifact' && previous.providerId === providerId ? previous.viewMode : 'preview' })
  }

  function setArtifactViewMode(tabId: string, viewMode: ArtifactViewMode) {
    store.update(tab => tab.id === tabId && tab.kind === 'artifact' ? { ...tab, viewMode } : tab)
  }

  function openBrowser(source = currentSource()) {
    const tab = spaceTaskBrowserTab(source?.conversationId ?? options.activeConversationId.value)
    if (tab)
      openTab({ ...tab, source })
  }

  function openChanges(target?: string | LocalChangeSetSummary, source?: ContextPanelSource, branchId = options.activeBranchId.value) {
    const conversationId = source?.conversationId ?? options.activeConversationId.value
    if (!conversationId)
      return
    const changeSet = typeof target === 'string'
      ? options.changeSets.value.find(set => set.changeSetId === target)
      : target
    if (target && (!changeSet || changeSet.conversationId !== conversationId))
      return
    openTab({
      id: source && changeSet ? `change-set:${changeSet.changeSetId}` : `changes:${conversationId}`,
      scope: taskContextPanelScope(conversationId),
      kind: 'changes',
      conversationId,
      branchId,
      revision: source && changeSet ? changeSet.updatedAt : changeRevision.value,
      changeSet: changeSet ?? null,
      source: source ?? currentSource(),
    })
  }

  function addBrowser() {
    const browserKey = crypto.randomUUID()
    openTab({ id: browserTabId(null, browserKey), scope: store.scope.value, kind: 'browser', conversationId: null, browserKey })
  }

  function openFiles(spaceId: string, directoryId?: string) {
    const space = fileSpaces.value.find(space => space.id === spaceId)
    const directories = getActiveSpaceDirectories(space)
    const directory = directoryId ? directories.find(directory => directory.id === directoryId) : directories[0]
    if (!space || !directory)
      return
    openTab({
      id: `files:${crypto.randomUUID()}`,
      scope: store.scope.value,
      kind: 'files',
      rootName: directory.root.split(/[\\/]/).filter(Boolean).at(-1) ?? directory.root,
      target: { spaceId: space.id, directoryId: directory.id, revision: directory.revision, path: '' },
      source: linked.value ? currentSource() : undefined,
    })
  }

  function locateFile(target: SpaceFileTarget, kind: 'file' | 'directory', source?: ContextPanelSource) {
    const space = fileSpaces.value.find(space => space.id === target.spaceId)
    const directory = getActiveSpaceDirectories(space).find(directory => directory.id === target.directoryId && directory.revision === target.revision)
    if (!directory)
      throw new Error('FILE_DIRECTORY_UNAVAILABLE')
    const candidates = store.tabs.value.filter(tab => tab.kind === 'files' && tab.target.spaceId === target.spaceId
      && tab.target.directoryId === target.directoryId && tab.target.revision === target.revision)
    const previous = candidates.find(tab => tab.id === store.activeTab.value?.id) ?? candidates[0]
    openTab({
      id: previous?.id ?? `files:${crypto.randomUUID()}`,
      scope: source ? taskContextPanelScope(source.conversationId) : previous?.scope ?? store.scope.value,
      kind: 'files',
      rootName: directory.root.split(/[\\/]/).filter(Boolean).at(-1) ?? directory.root,
      target: { ...target, path: kind === 'file' ? target.path : '' },
      treeTarget: { path: target.path, kind },
      source: source ?? previous?.source ?? currentSource(),
    })
  }

  function selectFile(tabId: string, path: string) {
    store.update(tab => tab.id === tabId && tab.kind === 'files' ? { ...tab, target: { ...tab.target, path }, treeTarget: undefined } : tab)
  }

  function isAvailable(tab: TaskContextTab): boolean {
    if (tab.kind !== 'files')
      return true
    const space = fileSpaces.value.find(space => space.id === tab.target.spaceId)
    const directory = getActiveSpaceDirectories(space).find(directory => directory.id === tab.target.directoryId)
    return Boolean(directory && tab.target.directoryId === directory.id && tab.target.revision === directory.revision)
  }

  function hasTab(id: string) {
    return store.resources.value.some(tab => tab.id === id)
  }

  function restoreTab(value: unknown) {
    const tab = readContextTab(value)
    if (tab && isAvailable(tab) && !hasTab(tab.id))
      store.put(tab, false)
  }

  return {
    restoreSnapshot(value: unknown) {
      if (!value || typeof value !== 'object')
        return
      const snapshot = value as { tabs?: unknown, selections?: unknown }
      if (Array.isArray(snapshot.tabs))
        snapshot.tabs.slice(0, 512).forEach(restoreTab)
      if (Array.isArray(snapshot.selections)) {
        for (const selection of snapshot.selections) {
          const parsed = readContextSelection(selection)
          if (parsed)
            store.restoreSelections([parsed])
        }
      }
    },
    snapshot: store.snapshot,
    restoreSelections: store.restoreSelections,
    openView: (viewId: string, label: string, source?: ContextPanelSource) => openTab({ kind: 'view', id: viewId, viewId, label, scope: source ? taskContextPanelScope(source.conversationId) : store.scope.value, ...(source ? { source } : {}) }),
    updateView: (viewId: string, label: string) => store.update(tab => tab.kind === 'view' && tab.viewId === viewId && tab.label !== label ? { ...tab, label } : tab),
    removeView: store.close,
    allTabs: store.resources,
    activeTab: store.activeTab,
    tabs: store.tabs,
    selectionScope: store.selectionScope,
    isOpen: control.isOpen,
    mode: options.mode,
    fileEntry: readonly(fileEntry),
    fileSpaces: readonly(fileSpaces),
    canAddChanges: readonly(canAddChanges),
    adoptDraft: store.adoptDraft,
    discardDraft: store.discardDraft,
    addBrowser,
    closeTab: store.close,
    discardConversation: (id: string) => store.discard(taskContextPanelScope(id)),
    hasTab,
    openArtifact,
    openBrowser,
    openChanges,
    openFiles,
    locateFile,
    selectFile,
    setArtifactViewMode,
    restoreTab,
    selectTab: store.select,
    closePanel: control.close,
    getSource,
    toggle: control.toggle,
  }
}
